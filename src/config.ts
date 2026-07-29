// Configuration (spec 01 §3.1): CLI flags layered over env layered over
// defaults, parsed with zod at the boundary (issue #54 rule) so every knob is
// validated once and the static type derives from the schema.
//
// The hosted voice's endpoint knobs come from env (spec 02 §3.6) so a URL or key
// is never hardcoded; the CLI overrides all of them except the API key, which
// stays env-only — a secret does not belong on the command line.

import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { z } from 'zod'

import { dataRoot } from './paths.ts'
import { DEFAULT_PERSONA_PATH } from './prompts.ts'

// The inter-sentence silence pad the hosted voice splices in (spec 02 §3.6). A
// by-ear knob: fish TTS runs sentences together and its own pause hints are
// inert, so we insert the gap ourselves. 0 disables splitting entirely.
const DEFAULT_SENTENCE_PAD_S = 0.8

export const ConfigSchema = z.object({
  // Which Brain to construct: 'claude' (real, default) or 'stub' (canned, no network).
  brain: z.enum(['claude', 'stub']).default('claude'),
  // 'hosted' is the real voice (spec 02 §3.6); local MLX voices are dropped.
  voice: z.enum(['stub', 'hosted']).default('stub'),
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
  ttsSentencePadS: z.coerce.number().min(0).default(DEFAULT_SENTENCE_PAD_S),

  // --- music (specs 03-01/03-02) ----------------------------------------- //
  musicEnabled: z.boolean().default(true),
  ytdlpCmd: z.string().default('yt-dlp'),
  // Cheap tier for the music-discovery task and the opt-in brain cadence
  // (master §7 pillar 3).
  musicModel: z.string().default('claude-haiku-4-5-20251001'),
  // Talk<->music scheduling mode (spec 03-02 §2.3).
  cadenceMode: z.enum(['every_n', 'random', 'brain']).default('every_n'),
  musicEveryN: z.coerce.number().int().positive().default(2),
  // The always-on background bed (spec 03-04); --no-bed or an empty cache
  // degrades to talk-with-silence.
  bedEnabled: z.boolean().default(true),

  // --- memory (spec 05) --------------------------------------------------- //
  // Home of the three persistent tiers (spec 05 §2.3) — under the one murmur
  // home, relocatable via MURMUR_HOME.
  memoryDir: z.string().default(() => join(dataRoot(), 'memory')),
  // Cheap tier for the background profile compaction (master §7 pillar 3).
  compactModel: z.string().default('claude-haiku-4-5-20251001'),
})

export type Config = z.infer<typeof ConfigSchema>

export type CliInvocation = {
  config: Config
  maxSegments: number | undefined
  // Run the music setup guide directly and exit (spec 03-03's explicit entry).
  setupMusic: boolean
  // Run the profile bootstrap standalone and exit (spec 06 §3.4's re-entry for
  // a listener who declined it on the first run).
  bootstrapProfile: boolean
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

// The MURMUR_TTS_* boundary (spec 02 §3.6) as Config fields.
function ttsFromEnv(env: NodeJS.ProcessEnv): Partial<Config> {
  const seed = envNumber(env, 'MURMUR_TTS_SEED', z.coerce.number().int().nonnegative())
  const padS = envNumber(env, 'MURMUR_TTS_SENTENCE_PAD_S', z.coerce.number().nonnegative())
  return {
    ttsUrl: env.MURMUR_TTS_URL?.trim() ?? '',
    ttsReferenceId: env.MURMUR_TTS_REFERENCE_ID?.trim() ?? '',
    ttsApiKey: env.MURMUR_TTS_API_KEY?.trim() ?? '',
    ttsModel: env.MURMUR_TTS_MODEL?.trim() ?? '',
    ...(seed !== undefined && { ttsSeed: seed }),
    ...(padS !== undefined && { ttsSentencePadS: padS }),
  }
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
      'no-music': { type: 'boolean' },
      'no-bed': { type: 'boolean' },
      'setup-music': { type: 'boolean' },
      'bootstrap-profile': { type: 'boolean' },
      cadence: { type: 'string' },
      'max-segments': { type: 'string' },
    },
  })
  const config = ConfigSchema.parse({
    ...ttsFromEnv(env),
    memoryDir: join(dataRoot(env), 'memory'),
    ...(values.brain !== undefined && { brain: values.brain }),
    ...(values.voice !== undefined && { voice: values.voice }),
    ...(values.model !== undefined && { model: values.model }),
    ...(values.persona !== undefined && { personaPath: values.persona }),
    ...(values.gap !== undefined && { gapSeconds: values.gap }),
    ...(values['tts-url'] !== undefined && { ttsUrl: values['tts-url'] }),
    ...(values['tts-model'] !== undefined && { ttsModel: values['tts-model'] }),
    ...(values['tts-reference'] !== undefined && { ttsReferenceId: values['tts-reference'] }),
    ...(values['no-music'] === true && { musicEnabled: false }),
    ...(values['no-bed'] === true && { bedEnabled: false }),
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
    bootstrapProfile: values['bootstrap-profile'] === true,
  }
}
