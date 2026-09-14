// First run (spec 06 §2.1/§3.1): the one time murmur has no persona yet.
//
// Three seed questions through the CLI Host, one Brain call folds the answers
// into a persona, and that text lands at the persona home — after which murmur
// NEVER writes that file again (master §2.3, amended): the persona is a stable,
// user-editable asset. Everything here is total: any refusal, failure or closed
// stdin degrades to the bundled seed, because the radio always boots.
//
// Slice B (the optional Claude Code history -> profile bootstrap) is offered
// here, before the persona call, and runs unawaited in the background once the
// persona is written — the same posture spec 05 §3.6 uses for startup
// catch-up compaction. The taste sources (spec 14 §3.9) are offered right
// after it, and a yes runs the /sources conversation before the persona
// call: every question is asked before the one long wait.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ccTools, type ProfileBootstrap } from './cc-tools.ts'
import type { Brain, Harness, SeedAnswer } from '../contracts.ts'
import { isYes, lineReader, QUIT, type QuitLatch, quitLatch, type ReadLine } from './guide.ts'
import { ask, type Host } from '../host/host.ts'
import { SOURCES_OFFER } from '../music/sources/flow.ts'
import { claudeCodeRoot } from '../paths.ts'
import { renderPersona } from '../brain/persona.ts'
import { PERSONA_CHAR_CAP, FIRST_RUN_INTRO, PERSONA_MIN_CHARS, SEED_QUESTIONS } from '../prompts/persona.ts'
import { BOOTSTRAP_OFFER, BOOTSTRAP_PROFILE_INSTRUCTION, BOOTSTRAP_PROFILE_SYSTEM_PROMPT } from '../prompts/profile.ts'

// Bounded agentic budget for the one-shot bootstrap (spec 06 §3.4/§6).
const BOOTSTRAP_MAX_TURNS = 12
// Typed on a seed question: step back to the previous one.
const BACK = '/back'
// The persona call is one tool-less generation on the good tier — normally
// well under a minute. Past this the listener is staring at a busy sign with
// nothing to do; the bundled seed is a better radio than a longer wait.
export const SEED_PERSONA_TIMEOUT_MS = 60_000

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
  // The machine-detected default output language (spec 06 §3.2), settled here
  // and only here: it fills the bundled seed's slot and backs the Brain up
  // where the answers name no language.
  language: string
  // Fired by a typed /quit (Ctrl-C in the TUI): reads decline through and the
  // app shuts down instead of broadcasting.
  quit?: QuitLatch
  ccRoot?: string // slice B's data root; defaults to the resolver in paths.ts
  // The /sources conversation (spec 14 §3.1), the same closure the Director
  // parks on for the command; absent (a stub run, no taste) = the sources
  // card is never shown.
  sourcesRecall?: () => Promise<void>
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
    // Rendered, not copied: what lands at the home is the listener's own
    // persona from here on, and it must read as finished text, not a template.
    const seed = readFileSync(deps.fallbackSeedPath, 'utf-8')
    atomicWrite(home, renderPersona(seed, deps.language))
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
  // A caller without a latch still gets one — and it must be THIS latch the
  // abandoned-conversation check below reads, or a /quit would decline every
  // read and then be mistaken for "skipped everything".
  const quit = deps.quit ?? quitLatch()
  const read = lineReader(host, quit)

  host.info(FIRST_RUN_INTRO)
  const given: string[] = SEED_QUESTIONS.map(() => '')
  // The whole first run is one step table walked by index (§3.4): the seed
  // questions, then the consent cards that are actually available on this run.
  // '/back' is a step back anywhere in it — every question is reachable again,
  // and a card is never the point of no return.
  const steps: Step[] = [
    ...SEED_QUESTIONS.map((_, i): Step => ({ kind: 'seed', index: i })),
    ...(deps.harness !== undefined ? [{ kind: 'bootstrap' } as Step] : []),
    ...(deps.sourcesRecall !== undefined ? [{ kind: 'sources' } as Step] : []),
  ]
  let bootstrap: BootstrapDeps | null = null
  let sourcesDone = false
  let allSkipped = false
  for (let i = 0; i < steps.length && !quit.requested; ) {
    const step = steps[i]!
    if (step.kind === 'seed') {
      const question = SEED_QUESTIONS[step.index]!
      const earlier = given[step.index]!
      // The earlier answer rides as a card note, and an empty line there keeps
      // it (the least surprising reading of Enter).
      ask(host, earlier === '' ? question : `${question}\n(you said: ${earlier} — Enter keeps it)`, 'question')
      const line = (await read()).trim()
      if (line === BACK) {
        if (i > 0) i--
        continue
      }
      if (line !== '') given[step.index] = line
      i++
      // Nothing said at all ends the run here: no consent card is worth asking
      // of a listener who answered nothing, and there is no persona to write.
      if (steps[i]?.kind !== 'seed' && given.every((g) => g === '')) {
        allSkipped = true
        break
      }
      continue
    }
    const offer = step.kind === 'bootstrap' ? BOOTSTRAP_OFFER : SOURCES_OFFER
    const answer = await askConsent(host, offer, read, quit)
    if (answer === 'back') {
      if (i > 0) i--
      continue
    }
    if (answer === 'quit') break
    if (step.kind === 'bootstrap') {
      // Re-answering REPLACES the earlier one: a yes taken back with /back
      // leaves nothing to launch.
      bootstrap = answer === 'yes' ? bootstrapDeps(deps) : null
      if (answer === 'no') host.info('skipped — murmur will get to know you as it goes.')
    } else if (answer === 'yes' && !sourcesDone) {
      // The one step with a side effect the table cannot walk back: once the
      // conversation has run, a later /back would re-mount an account.
      sourcesDone = true
      await runSourcesRecall(deps)
    }
    i++
  }

  const answers: SeedAnswer[] = SEED_QUESTIONS.map((question, i) => ({ question, answer: given[i]! }))

  // Leaving is not answering (codex review): a /quit run keeps the bundled
  // seed for THIS boot but writes no persona marker — the next boot asks
  // again from the top.
  if (quit.requested) return deps.fallbackSeedPath

  if (allSkipped || answers.every((a) => a.answer === '')) {
    host.info('no answers — starting with the default voice; you can edit it later.')
    return useBundledSeed(deps)
  }

  let persona: string
  // Writing the persona is a model call the listener waits on with nothing
  // else on screen — the one place in the first run where silence reads as a
  // hang (spec 10 §3.4). Two ways out of it: the latch (a /quit reaches it
  // through the host's side channel, no read needed) and the timeout. Either
  // aborts the subprocess; the race makes the exit prompt even if the abort
  // takes its time to unwind.
  const abort = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort.abort(new Error('the persona call timed out'))
  }, SEED_PERSONA_TIMEOUT_MS)
  const left = quit.seen.then(() => {
    abort.abort(new Error('the listener left'))
    throw new Error('the listener left')
  })
  host.setBusy?.(true)
  try {
    persona = (await Promise.race([deps.brain.seedPersona(answers, deps.language, abort.signal), left])).trim()
  } catch (err) {
    // Leaving is not answering (above): no marker, the next boot asks again.
    if (quit.requested) return deps.fallbackSeedPath
    if (timedOut) host.info('writing the persona took too long; using the default voice — edit it whenever you like.')
    else host.info(`could not write a persona from those answers (${String(err)}); using the default voice.`)
    return useBundledSeed(deps)
  } finally {
    clearTimeout(timer)
    host.setBusy?.(false)
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
  // A /quit typed during the wait is still queued — nobody was reading — and
  // the listener is leaving: honor it here rather than launch a task they
  // will not stay for. One macrotask beat separates "a line is queued" from
  // "nothing typed"; any other line stays queued for the radio.
  const queued = await Promise.race([host.peekLine(), new Promise<undefined>((r) => setTimeout(r, 0))])
  if (queued?.trim() === QUIT) {
    host.takeLine()
    quit.fire()
  }
  if (bootstrap !== null && !quit.requested) {
    host.info('reading in the background; the program starts now.')
    // Unawaited on purpose: the bootstrap must never delay the first beat, and
    // runProfileBootstrap is total, so there is no rejection to escape here.
    void runProfileBootstrap(bootstrap)
  }
  return home
}

// One consent card's answer (§3.4). The legal inputs are the only inputs: an
// unrecognized line re-asks the same card rather than counting as a no — a
// listener who typed '/back' or a question must never have it read as consent
// to nothing.
type ConsentAnswer = 'yes' | 'no' | 'back' | 'quit'

// A step in the first-run table. The seed questions carry their index; the
// cards are present only when this run can actually offer them.
type Step = { kind: 'seed'; index: number } | { kind: 'bootstrap' } | { kind: 'sources' }

const NO_ANSWERS = new Set(['', 'n', 'no'])

async function askConsent(host: Host, offer: readonly string[], read: ReadLine, quit: QuitLatch): Promise<ConsentAnswer> {
  for (;;) {
    ask(host, offer.join('\n'), 'consent')
    const line = (await read()).trim()
    if (quit.requested) return 'quit'
    if (line === BACK) return 'back'
    if (isYes(line)) return 'yes'
    if (NO_ANSWERS.has(line.toLowerCase())) return 'no'
    // The card already says how to answer ('y or Enter — one key decides');
    // showing it again IS the correction.
  }
}

// The taste-sources conversation (spec 14 §3.9): a yes runs /sources right
// there, so a new listener mounts an account in the same sitting instead of
// finding the command later. Total, like everything else on the first run: a
// store that cannot be written costs the connection, never the persona or the
// broadcast.
async function runSourcesRecall(deps: FirstRunDeps): Promise<void> {
  try {
    await deps.sourcesRecall?.()
  } catch (err) {
    deps.host.info(`could not finish connecting (${String(err)}) — /sources to try again later.`)
  }
}

// The slice-B task to launch on a yes (spec 06 §3.4): asking and running are
// separate moments — the task itself starts only once the persona is written.
function bootstrapDeps(deps: FirstRunDeps): BootstrapDeps | null {
  const { harness } = deps
  if (harness === undefined) return null
  return {
    harness,
    memory: deps.memory,
    host: deps.host,
    model: deps.model,
    ...(deps.ccRoot !== undefined && { ccRoot: deps.ccRoot }),
  }
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
