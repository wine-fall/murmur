// The five programs (spec 15 §2.1): the shape each one has on the air. Data
// only — the planner's brief for each lives with the prompts
// (src/prompts/program.ts), and the schedule draws over these ids.

import { readFileSync } from 'node:fs'

import { z } from 'zod'

export const PROGRAM_IDS = ['puzzle', 'today', 'record', 'poem', 'origin'] as const

export type ProgramId = (typeof PROGRAM_IDS)[number]

export type ProgramShape = {
  // The canonical title. The air speaks the listener's language, so this is
  // what the planner renders literally into it once, and code freezes (§2.2).
  readonly title: string
  // How long the program should run; sizes the outline, never cuts it.
  readonly targetMin: number
  // Outline points the planner is asked for. A song follows each one.
  readonly points: number
  // Beats per point, [min, max]: one beat call per point returns this many.
  readonly beats: readonly [number, number]
  // Days a canonical subject (a lead thinker for `puzzle`) stays out of
  // reach after it led a program. 0 = not deduped here.
  readonly cooldownDays: number
}

export const PROGRAMS: Readonly<Record<ProgramId, ProgramShape>> = {
  puzzle: { title: "Things I Can't Figure Out", targetMin: 40, points: 6, beats: [3, 4], cooldownDays: 30 },
  // Its items are deduped by the real-world ledger already (spec 13 §3.7).
  today: { title: 'This Thing Today', targetMin: 20, points: 3, beats: [3, 4], cooldownDays: 0 },
  // One track per point, 1-2 beats around it: one song per 1-2 beats.
  record: { title: 'One Record', targetMin: 30, points: 6, beats: [1, 2], cooldownDays: 30 },
  // The reading and its layers; a song after each.
  poem: { title: 'Read One', targetMin: 30, points: 4, beats: [2, 3], cooldownDays: 180 },
  origin: { title: 'Where It Comes From', targetMin: 30, points: 5, beats: [3, 4], cooldownDays: 90 },
}

// The listener's own names for a Chinese air (spec 15 §2.2), shipped as data
// beside this file: no CJK in source, and a name the planner renders drifts.
const CHINESE_NAMES = z
  .record(z.enum(PROGRAM_IDS), z.string())
  .parse(JSON.parse(readFileSync(new URL('./names.json', import.meta.url), 'utf8')))

// Han script without kana: what a generated persona's prose sample looks like
// when the air is Chinese and the language was never named.
const HAN = /\p{Script=Han}/u
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u

// ponytail: Chinese is the one shipped table; a second language adds a file.
export function fixedName(language: string, id: ProgramId): string | undefined {
  const chinese = /chinese|mandarin/i.test(language) || (HAN.test(language) && !KANA.test(language))
  return chinese ? CHINESE_NAMES[id] : undefined
}

// `today` airs commentary on real-world items and needs at least this many
// fresh, unused ones in the pool to be drawn at all.
export const TODAY_MIN_ITEMS = 2

// What a planning call hands back (spec 15 §2.4), as data: the outline the
// beats are said from. Also the persisted shape of a run, so it is a schema.
export const PointSchema = z.object({
  title: z.string(),
  content: z.string(),
  track: z.object({ artist: z.string(), title: z.string() }).optional(),
})

export const PlanSchema = z.object({
  name: z.string(),
  subject: z.string(),
  leads: z.array(z.string()).optional(),
  angle: z.string(),
  points: z.array(PointSchema).min(1),
})

export type Point = z.infer<typeof PointSchema>
export type Plan = z.infer<typeof PlanSchema>

// The program on the air (spec 15 §2.7): `next` is the point to say, and
// `opened` turns true once its first beat aired (when the ledger hears of it).
export const RunStateSchema = z.object({
  id: z.enum(PROGRAM_IDS),
  plan: PlanSchema,
  next: z.number().int().nonnegative(),
  opened: z.boolean(),
  requested: z.boolean(),
  updatedAt: z.number(), // epoch ms
})

export type RunState = z.infer<typeof RunStateSchema>
