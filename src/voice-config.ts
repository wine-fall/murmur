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
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'

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
  // Arm a per-call abort watch at handler entry. The user's Esc cuts a TURN;
  // this call may still be in flight when the next turn opens and resets the
  // flow-level flag, so the watch is scoped to the invocation: it answers
  // "did a cut land since THIS call began". A stop resolving the pending
  // promptSecret as '' must read as an abort — never as "no key, proceed".
  armAbort?: () => () => boolean
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
      const aborted = deps.armAbort?.() ?? (() => false)
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
            error: 'this session cannot ask for a key; run `murmur --setup` in a terminal',
          })
        }
        const key = (await deps.promptSecret(API_KEY_LABEL)).trim()
        if (aborted()) {
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
      // Esc while the probe synth was in flight: proven or not, the user cut
      // this call — persist nothing.
      if (aborted()) {
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

// --- cloning a timbre from the listener's own recording -------------------- //

// The fields the hosted create-model call requires, and the ones it answers
// with. Probed against the live API (2026-09-01) rather than taken from a doc
// page: `type` and `train_mode` are single-value constants there, and `fast`
// is the mode whose model is usable the moment it is created.
const MODEL_TYPE = 'tts'
const TRAIN_MODE = 'fast'

// What the listener can hand over as a recording. A closed list, not a check
// for "not a config": the model picks this path out of what the listener typed,
// and an upload sends whatever it names to a third party — so the failure to
// design against is a credential file reaching fish.audio, not a wrong codec.
const AUDIO_SUFFIX = /\.(wav|mp3|m4a|aac|flac|ogg|opus|webm)$/i

// Long enough for any voice sample, short enough that a mistyped path pointing
// at a video or an archive is refused before it is streamed anywhere.
const MAX_AUDIO_BYTES = 50 * 1024 * 1024

// How long an upload may run before it is cut loose, and how often the poll-
// shaped abort watch is bridged onto the request's signal. Generous: the
// recording is the listener's and the link is theirs, but not unbounded.
const UPLOAD_TIMEOUT_MS = 120_000
const ABORT_POLL_MS = 200

const CreatedModelSchema = z.object({ _id: z.string().trim().min(1) })

export type CreateVoiceDeps = {
  // The murmur home: the one file this may repoint.
  home: string
  // The endpoint the RUN is actually speaking through — env and flags layered
  // over voice.json, which is the order everything else resolves in. Absent
  // falls back to the file, which is all a bare tool has. Without this a
  // listener whose endpoint comes from .env (no voice.json at all) is told
  // there is no endpoint while the radio is talking through one.
  endpoint?: () => VoiceConfig | null
  // Expand a listener-typed path (`~/Downloads/me.m4a`). The model is asked to
  // pass the path along exactly as it was given, so the tilde arrives literal.
  expandPath?: (path: string) => string
  // Injected so the upload is testable without a network — and so the ONE
  // place the key is attached to a request stays visible in this module.
  fetchImpl?: typeof fetch
  // Same per-call abort watch as write_voice_config: an Esc mid-upload must
  // stop the listener's recording from leaving the machine.
  armAbort?: () => () => boolean
  // Fired after the new voice is pinned on disk. Receives the id and title —
  // both public, unlike the config the other tool hands its callback.
  onCreated?: (voice: { referenceId: string; title: string }) => void
}

// The second murmur-owned tool of the setup conversation. Like
// write_voice_config it owns the secret channel: the model names a local file
// and a title, and the KEY is read from the config this side of the boundary,
// attached to the upload, and never returned — so the guide can finish the
// whole voice setup, recording included, without a credential ever entering
// the transcript (spec 03-03 §7.2).
export function createVoiceTool(deps: CreateVoiceDeps): TaskTool {
  return tool(
    'create_voice',
    'Create a hosted voice from a LOCAL audio file the user recorded or has on ' +
      'disk, and pin murmur to it. Use this when the user wants their own voice ' +
      '(or any recording of theirs) instead of one from the provider library — ' +
      'you do not need their API key, this tool already has it. The endpoint ' +
      'must be configured first (write_voice_config). Give the path exactly as ' +
      'the user gave it to you.',
    {
      audioPath: z.string().describe('path to the local audio file the user named'),
      title: z.string().describe('a short name for the new voice, for the provider library'),
      text: z
        .string()
        .optional()
        .describe('what is said in the recording, if the user told you — improves the clone'),
    },
    async (args) => {
      const aborted = deps.armAbort?.() ?? (() => false)
      const target = resolveVoiceConfigTarget(deps.home)
      const saved = target === null ? null : readVoiceConfig(target)
      const config = deps.endpoint?.() ?? saved
      if (target === null || config === null) {
        return reply({
          ok: false,
          error: 'no voice endpoint is configured yet — call write_voice_config first',
        })
      }
      if (config.apiKey === undefined) {
        return reply({
          ok: false,
          error:
            'this endpoint has no API key saved, and creating a hosted voice needs one. A ' +
            'self-hosted server clones voices its own way, not through this tool.',
        })
      }
      const path = (deps.expandPath ?? ((given: string) => given))(args.audioPath.trim())
      if (!AUDIO_SUFFIX.test(path)) {
        return reply({
          ok: false,
          error:
            'that is not an audio file. Upload sends the file to the provider, so this tool ' +
            'takes only a recording (wav, mp3, m4a, aac, flac, ogg, opus, webm) — ask the ' +
            'user for the path to their audio.',
        })
      }
      // The suffix is what the file is CALLED. lstat is what it is: a link
      // named sample.wav can point at voice.json, and this tool — exempt from
      // the guard that refuses credential paths, because it owns the secret
      // channel — would then upload the key to a third party itself. It also
      // settles the size before a byte is read: a mistyped path at a video
      // must be turned away, not allocated whole into a boot it is repairing.
      let stat: Stats
      try {
        stat = lstatSync(path)
      } catch {
        return reply({ ok: false, error: `no file at ${path} — ask the user to check the path` })
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return reply({
          ok: false,
          error: `${path} is not a regular file — give the path to the recording itself`,
        })
      }
      if (stat.size === 0 || stat.size > MAX_AUDIO_BYTES) {
        return reply({
          ok: false,
          error: `${path} is ${String(stat.size)} bytes, which is not a voice sample`,
        })
      }
      let audio: Buffer
      try {
        audio = readFileSync(path)
      } catch {
        return reply({ ok: false, error: `${path} could not be read` })
      }
      // The listener's recording is about to leave their machine: a cut that
      // landed since this call began stops it here, before the upload.
      if (aborted()) return reply({ ok: false, error: 'the user stopped the setup' })

      const key = config.apiKey
      const scrub = (text: string): string => text.replaceAll(key, '<key>')
      const body = new FormData()
      body.set('type', MODEL_TYPE)
      body.set('train_mode', TRAIN_MODE)
      body.set('title', args.title)
      body.set('voices', new Blob([new Uint8Array(audio)]), basename(path))
      // The provider pairs each sample with its transcript; without one it
      // trains on the audio alone, which is the shape when the user did not say.
      if (args.text !== undefined && args.text.trim() !== '') body.set('texts', args.text.trim())

      // Esc has to reach the REQUEST, not just the gaps around it: the upload
      // can run for as long as the recording takes, and the abort watch is a
      // poll, so it is bridged onto a signal for the duration. The timeout is
      // the other half — a provider that never answers must not hold the
      // setup (and the boot behind it) open forever.
      const controller = new AbortController()
      const watch = setInterval(() => {
        if (aborted()) controller.abort()
      }, ABORT_POLL_MS)
      const expiry = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
      let created: unknown
      try {
        const response = await (deps.fetchImpl ?? fetch)(
          new URL('/model', config.ttsUrl).toString(),
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}` },
            body,
            signal: controller.signal,
          },
        )
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          return reply({
            ok: false,
            error: scrub(
              `the provider refused the upload (${String(response.status)}): ${detail.slice(0, 300)}`,
            ),
          })
        }
        created = await response.json()
      } catch (err) {
        if (aborted()) return reply({ ok: false, error: 'the user stopped the setup' })
        return reply({
          ok: false,
          error: scrub(`the upload did not go through: ${err instanceof Error ? err.message : String(err)}`),
        })
      } finally {
        clearInterval(watch)
        clearTimeout(expiry)
      }
      // A cut that landed while the request was in flight: the voice may exist
      // at the provider, but the listener said stop, so nothing is pinned here.
      if (aborted()) return reply({ ok: false, error: 'the user stopped the setup' })
      const parsed = CreatedModelSchema.safeParse(created)
      if (!parsed.success) {
        return reply({ ok: false, error: 'the provider answered without a voice id' })
      }
      const referenceId = parsed.data._id
      try {
        writeVoiceConfig(target, { ...(saved ?? config), referenceId })
      } catch (err) {
        return reply({
          ok: false,
          error: scrub(
            `the voice was created (${referenceId}) but pinning it failed: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          ),
        })
      }
      deps.onCreated?.({ referenceId, title: args.title })
      return reply({ ok: true, referenceId, title: args.title })
    },
  )
}
