// Configuration (spec 01 §3.1): CLI flags layered over env layered over
// defaults, parsed with zod at the boundary (issue #54 rule) so every knob is
// validated once and the static type derives from the schema.
//
// The hosted voice's endpoint knobs come from env (spec 02 §3.6) or the
// guide-written voice.json (spec 03-03 §7.2) so a URL or key is never
// hardcoded; the CLI overrides all of them except the API key, which never
// takes a flag — a secret does not belong on the command line.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { z } from 'zod'

import { LogEvidenceSchema, resolveLogSource, type LogEvidence } from './support/dev-log.ts'
import {
  dataRoot,
  homeRoot,
  musicPolicyPath,
  rwtPoolPath,
  settingsPath,
  tuiSocketPath,
  voiceConfigPath,
} from './paths.ts'
import { DEFAULT_PERSONA_PATH } from './prompts/persona.ts'
import { readSettingsFile } from './host/settings.ts'
import { MAX_SPEED, MIN_SPEED, readVoiceConfig, type VoiceConfig } from './voice/voice-config.ts'

// The inter-sentence silence pad the hosted voice splices in (spec 02 §3.6). A
// by-ear knob: fish TTS runs sentences together and its own pause hints are
// inert, so we insert the gap ourselves. 0 disables splitting entirely.
const DEFAULT_SENTENCE_PAD_S = 0.8

const TtsOverridesSchema = z
  .object({
    ttsUrl: z.string(),
    ttsReferenceId: z.string(),
    ttsApiKey: z.string(),
    ttsModel: z.string(),
    ttsSeed: z.coerce.number().int(),
    ttsSpeed: z.coerce.number().min(MIN_SPEED).max(MAX_SPEED),
  })
  .partial()

export const ConfigSchema = z.object({
  // Which Brain to construct: 'claude' (real, default) or 'stub' (canned, no network).
  brain: z.enum(['claude', 'stub']).default('claude'),
  // 'hosted' is the real voice (spec 02 §3.6); local MLX voices are dropped.
  // The default is endpoint-derived in parseCli — hosted when one is
  // configured, this stub otherwise.
  voice: z.enum(['stub', 'hosted']).default('stub'),
  // Whether `voice` above was ASKED FOR rather than derived. Provenance, not a
  // knob: a stub that the listener typed is a request for silence and survives
  // an endpoint arriving mid-boot (spec 03-03 §7.2), while a stub that merely
  // fell out of "no endpoint configured" does not.
  voiceExplicit: z.boolean().default(false),
  // Model id for the core loop; tiered models are spec 08.
  model: z.string().default('claude-opus-4-8'),
  personaPath: z.string().default(DEFAULT_PERSONA_PATH),
  // Natural pause between talk segments, seconds (spec 01 §3.4). A by-ear knob
  // that also bounds the talk rate so testing does not drain the subscription.
  gapSeconds: z.coerce.number().min(0).default(2),
  // Size of the recent-turns window handed to the Brain per call (master §6).
  // (The talk look-ahead depth is a Director module constant — spec 04 §3.3.)
  recentWindow: z.coerce.number().int().positive().default(12),
  // The decode binary behind the engine (spec 03-02 §4; replaces the retired
  // spec-01 playerCmd/--player — the engine has no external player).
  ffmpegCmd: z.string().default('ffmpeg'),

  // --- hosted voice (spec 02 §3.6) --------------------------------------- //
  // Empty url = not configured; the hosted voice then fails loudly at startup.
  ttsUrl: z.string().default(''),
  ttsReferenceId: z.string().default(''),
  ttsApiKey: z.string().default(''),
  ttsModel: z.string().default(''),
  // Pins the sampled timbre — fish-speech has no preset voices, so an unset
  // seed with no reference means a fresh voice per call.
  ttsSeed: z.coerce.number().int().optional(),
  // The speaking rate (fish.audio `prosody.speed`); unset = the voice's own.
  ttsSpeed: z.coerce.number().min(MIN_SPEED).max(MAX_SPEED).optional(),
  ttsSentencePadS: z.coerce.number().min(0).default(DEFAULT_SENTENCE_PAD_S),
  // The voice knobs env and flags stated for THIS run. A voice.json rewritten
  // by the setup conversation is re-layered under exactly these (voiceAfterSetup),
  // so a knob the run took from the file follows the file, and a knob it took
  // from the environment stands.
  ttsOverrides: TtsOverridesSchema.default({}),

  // --- music (specs 03-01/03-02) ----------------------------------------- //
  musicEnabled: z.boolean().default(true),
  ytdlpCmd: z.string().default('yt-dlp'),
  // Cheap tier for the music-discovery task and the opt-in brain cadence
  // (master §7 pillar 3).
  musicModel: z.string().default('claude-haiku-4-5-20251001'),
  // The listener-owned taste half of the pick instruction (spec 03-01 §2.3),
  // under the one murmur home. Absent = the built-in policy.
  musicPolicyPath: z.string().default(() => musicPolicyPath()),
  // The listening-data catalogue (spec 03-01 §2.3): a key, env-only like every
  // other secret, and the host that answers. Empty key = no similar_music /
  // top_tracks tools, and discovery degrades to search alone. Empty url = the
  // adapter's own default host.
  listeningApiKey: z.string().default(''),
  listeningUrl: z.string().default(''),
  // Talk<->music scheduling mode (spec 03-02 §2.3).
  cadenceMode: z.enum(['every_n', 'random', 'brain']).default('every_n'),
  musicEveryN: z.coerce.number().int().positive().default(2),
  // The always-on background bed (spec 03-04); --no-bed or an empty cache
  // degrades to talk-with-silence.
  bedEnabled: z.boolean().default(true),

  // --- real-world topics (spec 13 §2.6) ----------------------------------- //
  // On/off is a settings-layer knob (file < flag, anchorsEnabled's shape); the
  // numbers are env-only by-ear knobs. The fetch rides the cheap tier.
  rwtEnabled: z.boolean().default(true),
  rwtPoolPath: z.string().default(() => rwtPoolPath()),
  rwtModel: z.string().default('claude-haiku-4-5-20251001'),
  rwtP: z.coerce.number().min(0).max(1).default(0.35),
  rwtMinGap: z.coerce.number().int().nonnegative().default(1),
  rwtMaxGap: z.coerce.number().int().nonnegative().default(4),
  rwtStaleHours: z.coerce.number().positive().default(6),
  rwtTtlHours: z.coerce.number().positive().default(48),

  // --- proactive & pacing (spec 07 §3.7) ---------------------------------- //
  // On/off as config; the behavioral shape (thresholds, windows) stays as
  // module constants. Both off = pre-spec-07 behavior.
  anchorsEnabled: z.boolean().default(true),
  gatingEnabled: z.boolean().default(true),

  // Whether the TUI shows the pixel pet (spec 12 §3.7). An engine field only so
  // the settings layer can persist and serve it; the client env MURMUR_TUI_PET
  // stays the local final override.
  tuiPet: z.boolean().default(true),
  // The listener's mute (spec 12 §3.4): the engine's master output gain, a
  // settings-layer knob. Distinct from `voice` above — muted keeps synthesizing
  // and playing, just silently; `--voice stub` does not synthesize at all.
  muted: z.boolean().default(false),

  // --- front-end (spec 10 §2.2/§3.5) -------------------------------------- //
  // The TUI is the face murmur shows by default (spec 10 §6): it spawns the
  // OpenTUI client and speaks over the socket. A machine without bun falls back
  // to plain at the app level with one notice; --plain / TUI=0 opt out outright.
  frontEnd: z.enum(['plain', 'tui']).default('tui'),
  // The runtime the TUI client runs under — a provisioned binary like
  // yt-dlp/ffmpeg, never a dependency of the engine itself (spec 10 §2.2).
  bunCmd: z.string().default('bun'),
  // Where the TUI client package lives — a sibling of src/, resolved from the
  // engine's own location so the install (repo checkout or global npm dir) can
  // sit anywhere. A config field so tests can point it at a temp dir.
  tuiDir: z.string().default(join(import.meta.dirname, '..', 'tui')),
  // Where the two processes meet (spec 10 §2.3), resolved by paths.ts.
  tuiSocket: z.string().default(() => tuiSocketPath()),

  // The one murmur home (spec 05 §2.3), resolved once here rather than re-read
  // from the ambient env deeper in: it scopes the guide-written voice config
  // (spec 03-03 §7.2), so it must be the SAME home the rest of the run uses.
  home: z.string().default(() => homeRoot()),

  // Where diagnostics are mirrored (src/support/dev-log.ts). Resolved once here, at the
  // boundary, so the hosts take a decided path instead of re-reading the env;
  // empty = no dev log at all. The default is a dated file under the home, so a
  // plain `npm i -g` install has something to attach to a bug report.
  devLog: z.string().default(''),
  // The other half of that same decision: what a READER has to walk to find
  // those diagnostics again — the dated set, one named file, or nothing. It
  // travels as its own field rather than being inferred from `devLog`, because
  // recovering the shape by comparing that path against a default is a guess,
  // and the two roads that carry log evidence into a report (spec 10 §3.2-C)
  // would each be guessing separately.
  logEvidence: LogEvidenceSchema.default({ kind: 'none' }),

  // --- memory (spec 05) --------------------------------------------------- //
  // Home of the three persistent tiers (spec 05 §2.3) — under the one murmur
  // home, relocatable via MURMUR_HOME.
  memoryDir: z.string().default(() => join(dataRoot(), 'memory')),
  // Cheap tier for the background profile compaction (master §7 pillar 3).
  compactModel: z.string().default('claude-haiku-4-5-20251001'),
})

export type Config = z.infer<typeof ConfigSchema>

// Which murmur is this? The bug-report form (spec 10) asks the listener for a
// version, and an `npm i -g` install has no repo to look it up in. The manifest
// is one hop above the code in both layouts — src/config.ts in a dev run,
// dist/config.js in a published one — so resolve it relative to this module
// rather than the cwd. An unreadable manifest costs the banner a token, never
// the boot: the failure is reported as a value, not thrown.
export function packageVersion(from: string | URL = import.meta.url): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', from), 'utf8'))
    return z.object({ version: z.string() }).parse(manifest).version
  } catch {
    return 'unknown'
  }
}

export type CliInvocation = {
  config: Config
  maxSegments: number | undefined
  // Run the music setup guide directly and exit (spec 03-03's explicit entry).
  setupMusic: boolean
  // Run the FULL onboarding conversation directly and exit (spec 03-03 §7.1):
  // music binaries, bun, and the voice endpoint, in one serial pass.
  setup: boolean
  // Run the profile bootstrap standalone and exit (spec 06 §3.4's re-entry for
  // a listener who declined it on the first run).
  bootstrapProfile: boolean
  // Print the version and exit, like every other CLI.
  version: boolean
}

// A misconfigured number in a .env must not abort Config construction (and with
// it every voice) — warn and fall back to the documented default. Empty/unset is
// not a misconfiguration, so it degrades silently.
function envNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  schema: z.ZodType<number>,
): number | undefined {
  const raw = env[name]?.trim()
  if (!raw) return undefined
  // Validated to the SAME shape the field itself requires, so a value that gets
  // past here can never make ConfigSchema.parse throw.
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  console.warn(`warning: ignoring unusable ${name}=${JSON.stringify(raw)}`)
  return undefined
}

// The MURMUR_TTS_* boundary (spec 02 §3.6) as Config fields. Unset knobs are
// OMITTED rather than blanked, so the guide-written voice.json underneath keeps
// whatever env does not state (spec 03-03 §7.2: env beats file, per knob).
function ttsFromEnv(env: NodeJS.ProcessEnv): Partial<Config> {
  const seed = envNumber(env, 'MURMUR_TTS_SEED', z.coerce.number().int().nonnegative())
  const speed = envNumber(env, 'MURMUR_TTS_SPEED', z.coerce.number().min(MIN_SPEED).max(MAX_SPEED))
  const padS = envNumber(env, 'MURMUR_TTS_SENTENCE_PAD_S', z.coerce.number().nonnegative())
  const text = (name: string): string | undefined => {
    const value = env[name]?.trim()
    return value ? value : undefined
  }
  const url = text('MURMUR_TTS_URL')
  const referenceId = text('MURMUR_TTS_REFERENCE_ID')
  const apiKey = text('MURMUR_TTS_API_KEY')
  const model = text('MURMUR_TTS_MODEL')
  return {
    ...(url !== undefined && { ttsUrl: url }),
    ...(referenceId !== undefined && { ttsReferenceId: referenceId }),
    ...(apiKey !== undefined && { ttsApiKey: apiKey }),
    ...(model !== undefined && { ttsModel: model }),
    ...(seed !== undefined && { ttsSeed: seed }),
    ...(speed !== undefined && { ttsSpeed: speed }),
    ...(padS !== undefined && { ttsSentencePadS: padS }),
  }
}

// The MURMUR_RWT_* numbers (spec 13 §2.6): the same warn-and-default posture,
// omitted when unset so the schema default stands.
function rwtFromEnv(env: NodeJS.ProcessEnv): Partial<Config> {
  const p = envNumber(env, 'MURMUR_RWT_P', z.coerce.number().min(0).max(1))
  const minGap = envNumber(env, 'MURMUR_RWT_MIN_GAP', z.coerce.number().int().nonnegative())
  const maxGap = envNumber(env, 'MURMUR_RWT_MAX_GAP', z.coerce.number().int().nonnegative())
  const staleHours = envNumber(env, 'MURMUR_RWT_STALE_HOURS', z.coerce.number().positive())
  const ttlHours = envNumber(env, 'MURMUR_RWT_TTL_HOURS', z.coerce.number().positive())
  return {
    ...(p !== undefined && { rwtP: p }),
    ...(minGap !== undefined && { rwtMinGap: minGap }),
    ...(maxGap !== undefined && { rwtMaxGap: maxGap }),
    ...(staleHours !== undefined && { rwtStaleHours: staleHours }),
    ...(ttlHours !== undefined && { rwtTtlHours: ttlHours }),
  }
}

// The guide-written endpoint (spec 03-03 §7.2). The lowest layer of the three:
// a damaged or absent file is simply no endpoint, never a boot failure.
//
// `endpoint` is where this run actually points once env and flags have had
// their say. The saved key belongs to the saved endpoint and travels nowhere
// else — otherwise pointing a run at a self-hosted box with `--tts-url` would
// hand that box a hosted provider's credential.
export function ttsFromFile(saved: VoiceConfig | null, endpoint: string): Partial<Config> {
  if (saved === null) return {}
  const sameEndpoint = saved.ttsUrl.trim() === endpoint
  return {
    ttsUrl: saved.ttsUrl,
    ...(saved.model !== undefined && { ttsModel: saved.model }),
    ...(saved.referenceId !== undefined && { ttsReferenceId: saved.referenceId }),
    ...(saved.apiKey !== undefined && sameEndpoint && { ttsApiKey: saved.apiKey }),
    ...(saved.seed !== undefined && { ttsSeed: saved.seed }),
    ...(saved.speed !== undefined && { ttsSpeed: saved.speed }),
  }
}

// Both halves of the log decision, named as the config fields carry them.
function logSource(env: NodeJS.ProcessEnv): { devLog: string; logEvidence: LogEvidence } {
  const { path, evidence } = resolveLogSource(env)
  return { devLog: path, logEvidence: evidence }
}

export function parseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): CliInvocation {
  const { values } = parseArgs({
    args: argv,
    options: {
      brain: { type: 'string' },
      voice: { type: 'string' },
      model: { type: 'string' },
      persona: { type: 'string' },
      gap: { type: 'string' },
      'tts-url': { type: 'string' },
      'tts-model': { type: 'string' },
      'tts-reference': { type: 'string' },
      'tts-speed': { type: 'string' },
      'no-music': { type: 'boolean' },
      'no-bed': { type: 'boolean' },
      'no-anchors': { type: 'boolean' },
      'no-gating': { type: 'boolean' },
      'no-rwt': { type: 'boolean' },
      tui: { type: 'boolean' },
      plain: { type: 'boolean' },
      setup: { type: 'boolean' },
      'setup-music': { type: 'boolean' },
      'bootstrap-profile': { type: 'boolean' },
      version: { type: 'boolean' },
      cadence: { type: 'string' },
      'max-segments': { type: 'string' },
    },
  })
  // Endpoint precedence, lowest first: voice.json < env < flags.
  const saved = readVoiceConfig(voiceConfigPath(env))
  const fromEnv = ttsFromEnv(env)
  const endpoint = (values['tts-url'] ?? fromEnv.ttsUrl ?? saved?.ttsUrl ?? '').trim()
  const flagTts = {
    ...(values['tts-url'] !== undefined && { ttsUrl: values['tts-url'] }),
    ...(values['tts-model'] !== undefined && { ttsModel: values['tts-model'] }),
    ...(values['tts-reference'] !== undefined && { ttsReferenceId: values['tts-reference'] }),
    ...(values['tts-speed'] !== undefined && { ttsSpeed: values['tts-speed'] }),
  }
  const tts = { ...ttsFromFile(saved, endpoint), ...fromEnv, ...flagTts }
  // The listener's persisted knobs (spec 12 §2.2): the lowest layer, per knob.
  const fromSettings = readSettingsFile(settingsPath(env), (m) => console.warn(`warning: ${m}`))

  const config = ConfigSchema.parse({
    ...fromSettings,
    ...tts,
    home: homeRoot(env),
    memoryDir: join(dataRoot(env), 'memory'),
    musicPolicyPath: musicPolicyPath(env),
    rwtPoolPath: rwtPoolPath(env),
    ...rwtFromEnv(env),
    listeningApiKey: env.MURMUR_LISTENING_API_KEY?.trim() ?? '',
    listeningUrl: env.MURMUR_LISTENING_URL?.trim() ?? '',
    tuiSocket: tuiSocketPath(env),
    ...logSource(env),
    // Having an endpoint IS the reason to speak with it: a voice configured
    // through the setup conversation (spec 03-03 §7.2) would otherwise be
    // written, validated, and then silently ignored because the knob still
    // said 'stub'. An explicit --voice below still wins, both ways.
    ...(endpoint !== '' && { voice: 'hosted' }),
    ...(values.brain !== undefined && { brain: values.brain }),
    ...(values.voice !== undefined && { voice: values.voice, voiceExplicit: true }),
    ...(values.model !== undefined && { model: values.model }),
    ...(values.persona !== undefined && { personaPath: values.persona }),
    ...(values.gap !== undefined && { gapSeconds: values.gap }),
    ttsOverrides: { ...fromEnv, ...flagTts },
    ...(values['no-music'] === true && { musicEnabled: false }),
    ...(values['no-bed'] === true && { bedEnabled: false }),
    ...(values['no-anchors'] === true && { anchorsEnabled: false }),
    ...(values['no-gating'] === true && { gatingEnabled: false }),
    ...(values['no-rwt'] === true && { rwtEnabled: false }),
    ...(values.tui === true && { frontEnd: 'tui' }),
    // Last, so an explicit opt-out always wins over a redundant opt-in.
    ...(values.plain === true && { frontEnd: 'plain' }),
    ...(values.cadence !== undefined && { cadenceMode: values.cadence }),
  })
  const maxSegments =
    values['max-segments'] === undefined
      ? undefined
      : z.coerce.number().int().positive().parse(values['max-segments'])
  return {
    config,
    maxSegments,
    setupMusic: values['setup-music'] === true,
    setup: values.setup === true,
    bootstrapProfile: values['bootstrap-profile'] === true,
    version: values.version === true,
  }
}
