// Configuration (spec 01 §3.1): CLI flags layered over defaults, parsed with
// zod at the boundary (issue #54 rule) so every knob is validated once and the
// static type derives from the schema.

import { parseArgs } from 'node:util'

import { z } from 'zod'

import { DEFAULT_PERSONA_PATH } from './prompts.ts'

export const ConfigSchema = z.object({
  // Which Brain to construct: 'claude' (real, default) or 'stub' (canned, no network).
  brain: z.enum(['claude', 'stub']).default('claude'),
  // Phase 1 has only the stub voice; Phase 2 adds the hosted provider.
  voice: z.enum(['stub']).default('stub'),
  // Model id for the core loop; tiered models are spec 08.
  model: z.string().default('claude-opus-4-8'),
  personaPath: z.string().default(DEFAULT_PERSONA_PATH),
  // Natural pause between talk segments, seconds (spec 01 §3.4). A by-ear knob
  // that also bounds the talk rate so testing does not drain the subscription.
  gapSeconds: z.coerce.number().min(0).default(2),
  // Size of the recent-turns window handed to the Brain per call (master §6).
  recentWindow: z.coerce.number().int().positive().default(12),
  // Beats per batched next_talks call (spec 04 §3.2 / token-economy pillar 2).
  talkBatch: z.coerce.number().int().positive().default(2),
  // External player binary (interim; Phase 3's engine replaces it).
  playerCmd: z.string().default('afplay'),
})

export type Config = z.infer<typeof ConfigSchema>

export type CliInvocation = {
  config: Config
  maxSegments: number | undefined
}

export function parseCli(argv: string[]): CliInvocation {
  const { values } = parseArgs({
    args: argv,
    options: {
      brain: { type: 'string' },
      voice: { type: 'string' },
      model: { type: 'string' },
      persona: { type: 'string' },
      gap: { type: 'string' },
      player: { type: 'string' },
      'max-segments': { type: 'string' },
    },
  })
  const config = ConfigSchema.parse({
    ...(values.brain !== undefined && { brain: values.brain }),
    ...(values.voice !== undefined && { voice: values.voice }),
    ...(values.model !== undefined && { model: values.model }),
    ...(values.persona !== undefined && { personaPath: values.persona }),
    ...(values.gap !== undefined && { gapSeconds: values.gap }),
    ...(values.player !== undefined && { playerCmd: values.player }),
  })
  const maxSegments =
    values['max-segments'] === undefined
      ? undefined
      : z.coerce.number().int().positive().parse(values['max-segments'])
  return { config, maxSegments }
}
