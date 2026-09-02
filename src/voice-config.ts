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
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
// The speaking rate fish.audio accepts (`prosody.speed`); 1.0 = the reference
// clip's own pace. On s2.1-pro-free, 0.85 takes a clone reading at 4.8 chars/s
// down to 3.6 (spec 02 §3.6).
export const MIN_SPEED = 0.5
export const MAX_SPEED = 2
export const SpeedSchema = z.number().min(MIN_SPEED).max(MAX_SPEED)

export const VoiceConfigSchema = z.object({
  ttsUrl: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  referenceId: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1).optional(),
  seed: z.coerce.number().int().nonnegative().optional(),
  speed: z.coerce.number().min(MIN_SPEED).max(MAX_SPEED).optional(),
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

// murmur's own two timbres. The clips are NOT in the npm package: a listener
// with a voice of their own, or one picked from the provider library, should
// not download a clip they will never use — so the clips live in the repo and
// are fetched on demand, once, when the listener picks one. Each is pinned by
// sha256 because the bytes are uploaded under the listener's key: a file
// fetched from `main` is only trustworthy if it is the file this build
// expects. That is also why a clip is never edited in place — a new timbre is
// a new filename. The table itself is data beside the code (the transcript is
// in the clip's own language, which the sources may not carry).
const VoicePresetSchema = z.object({
  file: z.string().min(1),
  url: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string().min(1),
  // The clip's transcript: the provider pairs it with the audio, which
  // improves the clone.
  text: z.string().min(1),
})
const VoicePresetsSchema = z.object({ male: VoicePresetSchema, female: VoicePresetSchema })
export const VOICE_PRESETS = VoicePresetsSchema.parse(
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../assets/voice-presets.json', import.meta.url)), 'utf-8'),
  ),
)
export type VoicePreset = keyof typeof VOICE_PRESETS

// Where a fetched clip lands: under cache/, rebuildable — a deleted clip costs
// one more download. Kept per home rather than per run so the second preset,
// or a change of mind, does not go back to GitHub.
const PRESET_CACHE_DIR = 'voices'
const PRESET_FETCH_TIMEOUT_MS = 30_000

// The clip for a preset: the cached copy if its bytes still match the pin, a
// fresh download otherwise (verified the same way before it is kept). A miss
// on either is an error that carries the URL, so the guide can hand the
// listener the file to fetch by hand and finish through `audioPath`.
async function presetClip(
  preset: VoicePreset,
  home: string,
  fetchImpl: typeof fetch,
  aborted: () => boolean,
): Promise<{ audio: Buffer } | { error: string }> {
  const spec = VOICE_PRESETS[preset]
  const matches = (bytes: Buffer): boolean =>
    createHash('sha256').update(bytes).digest('hex') === spec.sha256
  const cached = join(home, 'cache', PRESET_CACHE_DIR, spec.file)
  try {
    const bytes = readFileSync(cached)
    if (matches(bytes)) return { audio: bytes }
  } catch {
    // not cached yet
  }
  // Esc has to reach the download as well as the upload: the poll-shaped
  // abort watch is bridged onto the request's signal beside the timeout.
  const controller = new AbortController()
  const watch = setInterval(() => {
    if (aborted()) controller.abort()
  }, ABORT_POLL_MS)
  let bytes: Buffer
  try {
    const response = await fetchImpl(spec.url, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(PRESET_FETCH_TIMEOUT_MS)]),
    })
    if (!response.ok) {
      return { error: `the download failed (${String(response.status)}): ${spec.url}` }
    }
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (err) {
    if (aborted()) return { error: 'the user stopped the setup' }
    return {
      error: `the download did not go through (${err instanceof Error ? err.message : String(err)}): ${spec.url}`,
    }
  } finally {
    clearInterval(watch)
  }
  if (aborted()) return { error: 'the user stopped the setup' }
  if (!matches(bytes)) {
    return { error: `the downloaded clip did not match the one this murmur expects: ${spec.url}` }
  }
  // The cache is a convenience, not the deliverable: a home whose cache/ is
  // not writable still gets its voice, at the price of the next download.
  try {
    mkdirSync(join(home, 'cache', PRESET_CACHE_DIR), { recursive: true })
    writeFileSync(cached, bytes)
  } catch {
    // uncached
  }
  return { audio: bytes }
}

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
    'Create a hosted voice and pin murmur to it — either one of murmur\'s own two ' +
      'timbres (preset: male or female; murmur fetches the clip itself) or a LOCAL ' +
      'audio file the user recorded or has on disk (audioPath + title, given exactly ' +
      'as the user gave it). Either way you do not need their API key, this tool ' +
      'already has it. The endpoint must be configured first (write_voice_config).',
    {
      preset: z
        .enum(['male', 'female'])
        .optional()
        .describe("one of murmur's own voices; leave audioPath out when set"),
      audioPath: z
        .string()
        .optional()
        .describe('path to the local audio file the user named (when no preset)'),
      title: z
        .string()
        .optional()
        .describe('a short name for the new voice, for the provider library (required with audioPath)'),
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
      let audio: Buffer
      let title: string
      let text: string | undefined
      let named: string
      if (args.preset !== undefined) {
        const clip = await presetClip(args.preset, deps.home, deps.fetchImpl ?? fetch, aborted)
        if ('error' in clip) return reply({ ok: false, error: clip.error })
        audio = clip.audio
        title = args.title?.trim() || VOICE_PRESETS[args.preset].title
        text = VOICE_PRESETS[args.preset].text
        named = VOICE_PRESETS[args.preset].file
      } else {
        if (args.audioPath === undefined || args.title === undefined || args.title.trim() === '') {
          return reply({
            ok: false,
            error: 'give either a preset (male / female) or an audioPath with a title',
          })
        }
        title = args.title.trim()
        text = args.text
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
        try {
          audio = readFileSync(path)
        } catch {
          return reply({ ok: false, error: `${path} could not be read` })
        }
        named = basename(path)
      }
      // The listener's recording is about to leave their machine: a cut that
      // landed since this call began stops it here, before the upload.
      if (aborted()) return reply({ ok: false, error: 'the user stopped the setup' })

      const key = config.apiKey
      const scrub = (text: string): string => text.replaceAll(key, '<key>')
      const body = new FormData()
      body.set('type', MODEL_TYPE)
      body.set('train_mode', TRAIN_MODE)
      body.set('title', title)
      body.set('voices', new Blob([new Uint8Array(audio)]), named)
      // The provider pairs each sample with its transcript; without one it
      // trains on the audio alone, which is the shape when the user did not say.
      if (text !== undefined && text.trim() !== '') body.set('texts', text.trim())

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
      deps.onCreated?.({ referenceId, title })
      return reply({ ok: true, referenceId, title })
    },
  )
}

export type SetVoiceSpeedDeps = {
  home: string
  // One real line at the new rate, through the live endpoint, before anything
  // is written — the same proof write_voice_config demands.
  validate: (config: VoiceConfig) => Promise<void>
  // The endpoint the run is speaking through (env and flags over the file);
  // absent, the saved file is the endpoint.
  endpoint?: () => VoiceConfig | null
  armAbort?: () => () => boolean
  onWritten?: (speed: number) => void
}

// The third murmur-owned setup tool (spec 03-03 §7.2): the speaking rate. A
// clone inherits its reference clip's pace and the model drifts faster still,
// so "slower" is the one change a listener asks for after the timbre is
// settled. Proven by one synth at the new rate, then the one field is written
// into the saved config — nothing else in it moves.
export function setVoiceSpeedTool(deps: SetVoiceSpeedDeps): TaskTool {
  return tool(
    'set_voice_speed',
    "Change how fast murmur's voice reads, and prove it with one real line before " +
      'saving. 1.0 is the voice as recorded; 0.85 reads noticeably calmer; 1.15 ' +
      'brisker. Applies to the endpoint already configured — you do not need the ' +
      'API key, this tool has it.',
    {
      speed: z
        .number()
        .describe(`the speaking rate, ${String(MIN_SPEED)} to ${String(MAX_SPEED)}; 1.0 = unchanged`),
    },
    async (args) => {
      const aborted = deps.armAbort?.() ?? (() => false)
      const speed = SpeedSchema.safeParse(args.speed)
      if (!speed.success) {
        return reply({
          ok: false,
          error: `speed must be a number between ${String(MIN_SPEED)} and ${String(MAX_SPEED)} (1.0 = the voice as recorded)`,
        })
      }
      const target = resolveVoiceConfigTarget(deps.home)
      const saved = target === null ? null : readVoiceConfig(target)
      const live = deps.endpoint?.() ?? saved
      if (target === null || live === null) {
        return reply({
          ok: false,
          error: 'no voice endpoint is configured yet — call write_voice_config first',
        })
      }
      const scrub = (text: string): string =>
        live.apiKey === undefined ? text : text.replaceAll(live.apiKey, '<key>')
      try {
        await deps.validate({ ...live, speed: speed.data })
      } catch (err) {
        return reply({
          ok: false,
          error: scrub(
            `the endpoint did not answer at that speed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        })
      }
      if (aborted()) return reply({ ok: false, error: 'the user stopped the setup' })
      try {
        writeVoiceConfig(target, { ...(saved ?? live), speed: speed.data })
      } catch (err) {
        return reply({
          ok: false,
          error: scrub(`could not save the speed: ${err instanceof Error ? err.message : String(err)}`),
        })
      }
      deps.onWritten?.(speed.data)
      return reply({ ok: true, speed: speed.data })
    },
  )
}
