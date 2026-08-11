// First run (spec 06 §2.1/§3.1): the one time murmur has no persona yet.
//
// Three seed questions through the CLI Host, one Brain call folds the answers
// into a persona, and that text lands at the persona home — after which murmur
// NEVER writes that file again (master §2.3, amended): the persona is a stable,
// user-editable asset. Everything here is total: any refusal, failure or closed
// stdin degrades to the bundled seed, because the radio always boots.
//
// Slice B (the optional Claude Code history -> profile bootstrap) is offered
// here and runs unawaited in the background, the same posture spec 05 §3.6 uses
// for startup catch-up compaction.

import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ccTools, type ProfileBootstrap } from './cc-tools.ts'
import type { Brain, Harness, SeedAnswer } from './contracts.ts'
import { isYes, lineReader, type ReadLine } from './guide.ts'
import { ask, type Host } from './host.ts'
import { claudeCodeRoot } from './paths.ts'
import {
  BOOTSTRAP_OFFER,
  PERSONA_CHAR_CAP,
  BOOTSTRAP_PROFILE_INSTRUCTION,
  BOOTSTRAP_PROFILE_SYSTEM_PROMPT,
  FIRST_RUN_INTRO,
  PERSONA_MIN_CHARS,
  SEED_QUESTIONS,
} from './prompts.ts'

// Bounded agentic budget for the one-shot bootstrap (spec 06 §3.4/§6).
const BOOTSTRAP_MAX_TURNS = 12

// The spec-05 store surface slice B needs (spec 06 §2.4). Impl-level and
// deliberately NOT on the MemoryStore contract: the Director never writes the
// profile.
export interface ProfileWritable {
  profile(): string
  writeProfile(text: string): void
}

export type FirstRunDeps = {
  host: Host // the same CLI Host the Director uses (spec 01)
  brain: Pick<Brain, 'seedPersona'>
  harness?: Harness // slice B only; absent = slice B is never offered
  memory: ProfileWritable
  memoryDir: string
  fallbackSeedPath: string // config.personaPath — the bundled seed
  model: string // the good tier: this runs once per install (§3.3)
  ccRoot?: string // slice B's data root; defaults to the resolver in paths.ts
}

export function isFirstRun(memoryDir: string): boolean {
  return !existsSync(personaHome(memoryDir))
}

function personaHome(memoryDir: string): string {
  return join(memoryDir, 'persona.md')
}

// Temp file + rename in the same directory (spec 05 §3.1 discipline).
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, path)
}

// Today's behavior, kept as the floor under every failure: the bundled seed
// becomes the user's persona, at the home, where they can edit it.
function useBundledSeed(deps: FirstRunDeps): string {
  const home = personaHome(deps.memoryDir)
  try {
    mkdirSync(deps.memoryDir, { recursive: true })
    copyFileSync(deps.fallbackSeedPath, home)
    return home
  } catch {
    // Even the copy failed (a read-only home?). Load the seed where it lies —
    // the radio still goes on the air.
    return deps.fallbackSeedPath
  }
}

// Returns the path to load the persona from. Total: never throws, never blocks
// the radio; every failure degrades to the bundled seed.
export async function runFirstRun(deps: FirstRunDeps): Promise<string> {
  const { host } = deps
  const home = personaHome(deps.memoryDir)
  // The reader is the guide's (spec 03-03): serialized, and EOF resolves '' so
  // a piped run declines every question instead of wedging startup.
  host.start()
  const read = lineReader(host)

  host.info(FIRST_RUN_INTRO)
  const answers: SeedAnswer[] = []
  for (const question of SEED_QUESTIONS) {
    ask(host, question, 'question')
    answers.push({ question, answer: (await read()).trim() })
  }

  if (answers.every((a) => a.answer === '')) {
    host.info('no answers — starting with the default voice; you can edit it later.')
    return useBundledSeed(deps)
  }

  let persona: string
  try {
    persona = (await deps.brain.seedPersona(answers)).trim()
  } catch (err) {
    host.info(`could not write a persona from those answers (${String(err)}); using the default voice.`)
    return useBundledSeed(deps)
  }
  // Empty or a stray one-liner is a failed generation, not a persona (§3.3).
  if (persona.length < PERSONA_MIN_CHARS) {
    host.info('that did not come back as a usable persona; using the default voice.')
    return useBundledSeed(deps)
  }
  // The cap is enforced on what is WRITTEN, not merely requested in the prompt:
  // this file becomes the stable prefix of every later call, so a model that
  // overshoots would otherwise cost latency on every beat until hand-edited.
  const trimmed = persona.length > PERSONA_CHAR_CAP

  try {
    mkdirSync(deps.memoryDir, { recursive: true })
    atomicWrite(home, trimmed ? persona.slice(0, PERSONA_CHAR_CAP) : persona)
  } catch (err) {
    host.info(`could not save the persona (${String(err)}); using the default voice.`)
    return useBundledSeed(deps)
  }

  host.info(`here is who you will be listening to: ${persona.split('\n')[0] ?? ''}`)
  if (trimmed) host.info('(it came back long, so the tail was trimmed — worth a read.)')
  host.info(`it lives at ${home} — edit it whenever you like; murmur never rewrites it.`)
  await offerBootstrap(deps, read)
  return home
}

// The slice-B offer (spec 06 §3.4): explicit consent, default no, asked once
// and never re-asked — the existence of persona.md is the only first-run
// marker, so there is no "already offered" state to keep.
async function offerBootstrap(deps: FirstRunDeps, read: ReadLine): Promise<void> {
  const { harness } = deps
  if (harness === undefined) return // no real brain: nothing to run the task on
  // The framing is context for the log; only the closing y/N is the question.
  for (const line of BOOTSTRAP_OFFER.slice(0, -1)) deps.host.info(line)
  ask(deps.host, BOOTSTRAP_OFFER.at(-1)!, 'consent')
  if (!isYes(await read())) {
    deps.host.info('skipped — murmur will get to know you as it goes.')
    return
  }
  deps.host.info('reading in the background; the program starts now.')
  // Unawaited on purpose: the bootstrap must never delay the first beat, and
  // runProfileBootstrap is total, so there is no rejection to escape here.
  void runProfileBootstrap({
    harness,
    memory: deps.memory,
    host: deps.host,
    model: deps.model,
    ...(deps.ccRoot !== undefined && { ccRoot: deps.ccRoot }),
  })
}

export type BootstrapDeps = {
  harness: Harness
  memory: ProfileWritable
  host: Pick<Host, 'info' | 'debug'>
  model: string
  ccRoot?: string
}

// One bounded agentic pass over the user's Claude Code history -> the initial
// profile (spec 06 §2.3/§3.4). One-shot: no retry, no schedule. Total — it runs
// unawaited beside the live radio, so a failure costs the accelerator and
// nothing else.
export async function runProfileBootstrap(deps: BootstrapDeps): Promise<boolean> {
  const { host, memory } = deps
  // Checked BEFORE the task, not only at apply time: with a profile already
  // formed nothing could be written anyway, and launching would read the
  // user's private history and spend a model call for a result destined to be
  // dropped. The apply-time check stays too — the first-run bootstrap races
  // compaction while the radio is on air.
  if (memory.profile().trim() !== '') {
    host.debug?.('profile bootstrap: a profile already exists; not reading anything')
    return false
  }
  try {
    const root = deps.ccRoot ?? claudeCodeRoot()
    const result = await deps.harness.runTask<ProfileBootstrap>({
      systemPrompt: BOOTSTRAP_PROFILE_SYSTEM_PROMPT,
      prompt: BOOTSTRAP_PROFILE_INSTRUCTION,
      model: deps.model,
      maxTurns: BOOTSTRAP_MAX_TURNS,
      tools: (finish) => ccTools(root, finish),
    })
    if (result === null) {
      host.debug?.('profile bootstrap: ran out of turns before submitting')
      return false
    }
    // Apply rule (§2.4): the radio is already on air and compaction may have
    // landed first. A profile that has started forming is never clobbered.
    if (memory.profile().trim() !== '') {
      host.debug?.('profile bootstrap: a profile already formed; dropping the bootstrap result')
      return false
    }
    memory.writeProfile(result.profile)
    host.info('got a first sense of you from your Claude Code history.')
    return true
  } catch (err) {
    host.debug?.(`profile bootstrap failed: ${String(err)}`)
    return false
  }
}
