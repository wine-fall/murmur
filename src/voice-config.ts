// The guide-written voice endpoint (spec 03-03 §7.2).
//
// murmur assumes the user has Claude Code, so a missing voice endpoint is fixed
// by TALKING to murmur rather than by editing a dotfile: the setup conversation
// asks where the endpoint comes from, the user pastes it, and this module's
// tool proves it works — by synthesizing ONE real line through it — before a
// single byte lands on disk.
//
// Two boundaries meet here, so both are enforced locally rather than trusted:
// the file is zod-parsed on every read (hand-edited, torn, or from another
// murmur version), and the write is realpath-scoped to exactly one path inside
// the murmur home (the spec 06 slice-B posture — the write is murmur's, not the
// SDK's, precisely so that scope is enforceable).
//
// A hosted endpoint needs more than a URL — fish.audio requires a Bearer key
// AND a `model` header, and pins timbre by `reference_id` — so the file mirrors
// the MURMUR_TTS_* env surface knob for knob. The key is a secret: the file is
// owner-only, and the tool captures it OUT-OF-BAND rather than taking it as an
// argument, so it never becomes a message in the conversation (spec 03-03 §7.2).
//
// `.env` stays a dev-time override the app NEVER writes; env beats this file.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type { TaskTool } from './contracts.ts'

export const VOICE_CONFIG_FILE = 'voice.json'

// What the validation synth says. Short on purpose: it is a proof of life on
// the endpoint, and the user pays for every token of it.
export const VOICE_PROBE_LINE = 'Radio check.'

// What the user is asked for when an endpoint needs a credential. Named, not
// generic: the prompt is the only place the user learns WHICH secret is wanted.
export const API_KEY_LABEL = 'API key'

// An empty url is not a configured endpoint — it is the absence of one, and
// must read as "still a gap" rather than as a config that silently does nothing.
// Everything else is optional: a self-hosted server is fully described by its
// URL, and only a hosted API needs the model/reference/key knobs.
export const VoiceConfigSchema = z.object({
  ttsUrl: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  referenceId: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1).optional(),
  seed: z.coerce.number().int().nonnegative().optional(),
})

export type VoiceConfig = z.infer<typeof VoiceConfigSchema>

// null = no usable config. A damaged file degrades the voice, never boot.
export function readVoiceConfig(path: string): VoiceConfig | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const config = VoiceConfigSchema.safeParse(parsed)
  return config.success ? config.data : null
}

// Temp file + rename in the same directory — the spec 05 §3.1 write discipline,
// so a reader never sees a torn config. Owner-only from the moment it exists:
// the file may hold an API key, and the rename carries the mode to the target
// (chmod as well as the create mode, because a leftover tmp keeps its own).
export function writeVoiceConfig(path: string, config: VoiceConfig): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

// The ONE path the setup conversation may write, or null if it cannot be
// resolved safely. The home itself is resolved with realpath (relocating
// ~/.murmur with a symlink is normal), but a symlink planted AT voice.json is
// refused — that is the case where a write inside the home would land outside it.
export function resolveVoiceConfigTarget(home: string): string | null {
  let realHome: string
  try {
    mkdirSync(home, { recursive: true })
    realHome = realpathSync(home)
  } catch {
    return null
  }
  const target = join(realHome, VOICE_CONFIG_FILE)
  if (existsSync(target)) {
    try {
      if (realpathSync(target) !== target) return null
    } catch {
      return null
    }
  }
  return target
}

export type WriteVoiceConfigDeps = {
  // The murmur home; the tool derives the single writable path from it.
  home: string
  // Prove the endpoint by synthesizing one real line. Throws to reject.
  validate: (config: VoiceConfig) => Promise<void>
  // Ask the USER for a secret, directly — outside the model conversation.
  // Absent = this session has no keyboard to ask with (a non-interactive run),
  // which is a refusal, not a silent keyless write.
  promptSecret?: (label: string) => Promise<string>
  // The user stopped the flow (Esc / quit). The stop resolves a pending
  // promptSecret as '', which must read as an abort — never as "no key,
  // proceed": a validating synth and a saved voice.json after the user asked
  // to stop are side effects nobody consented to.
  aborted?: () => boolean
  // Fired only after a validated config has actually landed on disk. Receives
  // the config, so a consumer must print only the fields it means to (the URL).
  onWritten?: (config: VoiceConfig) => void
}

function reply(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

// The ONE murmur-owned tool the setup conversation gets beyond the SDK
// built-ins (spec 03-03 §7.2). It takes no path: the destination is closure-
// bound, so the model can never name a file murmur did not offer it. And it
// takes no key: `needsApiKey` only tells the tool to ASK, so the secret travels
// user -> tool and never through a message the SDK would send and transcribe.
export function writeVoiceConfigTool(deps: WriteVoiceConfigDeps): TaskTool {
  return tool(
    'write_voice_config',
    "Save murmur's voice endpoint. Validates it first by synthesizing one real " +
      'line through it; nothing is written if that fails. This is the only way ' +
      'to set the endpoint — never edit .env or any other file for it. If the ' +
      'endpoint needs an API key, set needsApiKey and murmur will ask the user ' +
      'for it directly — never ask them to type a key to you.',
    {
      ttsUrl: z.string().describe('the TTS endpoint base URL the user gave you'),
      model: z
        .string()
        .optional()
        .describe('the hosted model, sent as the `model` header (fish.audio requires one)'),
      referenceId: z
        .string()
        .optional()
        .describe('the hosted voice id that pins the timbre (fish.audio reference_id)'),
      seed: z.coerce
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('optional voice seed for a self-hosted server, if the user asked for one'),
      needsApiKey: z
        .boolean()
        .optional()
        .describe('true if this endpoint authenticates with a key; murmur will ask the user for it'),
    },
    async (args) => {
      const parsed = VoiceConfigSchema.safeParse(args)
      if (!parsed.success) {
        return reply({ ok: false, error: 'a non-empty ttsUrl is required' })
      }
      // Resolved BEFORE anything else: an endpoint we could never persist is
      // worth neither a real TTS call nor asking the user for a credential.
      const target = resolveVoiceConfigTarget(deps.home)
      if (target === null) {
        return reply({ ok: false, error: 'the voice config path is not writable safely' })
      }
      let config = parsed.data
      if (args.needsApiKey === true) {
        if (deps.promptSecret === undefined) {
          return reply({
            ok: false,
            error: 'this session cannot ask for a key; run `make setup` in a terminal',
          })
        }
        const key = (await deps.promptSecret(API_KEY_LABEL)).trim()
        if (deps.aborted?.() === true) {
          return reply({ ok: false, error: 'the user stopped the setup' })
        }
        if (key !== '') config = { ...config, apiKey: key }
      }
      // Everything that leaves here goes into the conversation, and a failing
      // endpoint's own error body is untrusted text — one that echoes the
      // Authorization header back would undo the whole out-of-band capture.
      const scrub = (text: string): string =>
        config.apiKey === undefined ? text : text.replaceAll(config.apiKey, '<key>')
      const message = (err: unknown): string =>
        scrub(err instanceof Error ? err.message : String(err))

      try {
        await deps.validate(config)
      } catch (err) {
        return reply({ ok: false, error: `the endpoint did not answer: ${message(err)}` })
      }
      // Esc while the probe synth was in flight: proven or not, the user is
      // gone — persist nothing.
      if (deps.aborted?.() === true) {
        return reply({ ok: false, error: 'the user stopped the setup' })
      }
      try {
        writeVoiceConfig(target, config)
      } catch (err) {
        return reply({ ok: false, error: message(err) })
      }
      deps.onWritten?.(config)
      // The FACT of a key, never the key: this payload goes back to the model.
      return reply({ ok: true, path: target, keySaved: config.apiKey !== undefined })
    },
  )
}
