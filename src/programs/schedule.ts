// The schedule (spec 15 §2.3): which program airs next, decided in code at 0
// tokens. A weighted draw with a two-program gap; the weights are dealt out
// at random and re-dealt every few days, so the station's character drifts
// without anyone choosing it. Persisted under the murmur home with the frozen
// program names (§2.2) and the run on the air (§2.7).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { z } from 'zod'

import { PROGRAM_IDS, type ProgramId, type RunState, RunStateSchema } from './catalogue.ts'

export const WEIGHTS = [1, 1, 2, 3, 4] as const
export const RESHUFFLE_DAYS = 3
// The last this-many aired programs cannot be drawn while anything else can.
export const GAP = 2

const DAY_MS = 86_400_000

export function drawProgram(opts: {
  weights: Readonly<Record<ProgramId, number>>
  recent: readonly ProgramId[] // newest last
  eligible: readonly ProgramId[]
  random: () => number
}): ProgramId | null {
  const blocked = new Set(opts.recent.slice(-GAP))
  const open = opts.eligible.filter((id) => !blocked.has(id))
  // Relaxed rather than silent: a gap that empties the field (say the only
  // other eligible program just aired) yields to the field.
  const field = open.length > 0 ? open : [...opts.eligible]
  const total = field.reduce((sum, id) => sum + opts.weights[id], 0)
  if (field.length === 0) return null
  if (total <= 0) return field[Math.floor(opts.random() * field.length)] ?? field[0]!
  let r = opts.random() * total
  for (const id of field) {
    r -= opts.weights[id]
    if (r < 0) return id
  }
  return field.at(-1)!
}

const WeightsSchema = z.object(Object.fromEntries(PROGRAM_IDS.map((id) => [id, z.number()])) as Record<ProgramId, z.ZodNumber>)

const FileSchema = z.object({
  weights: WeightsSchema.optional(),
  shuffledAt: z.number().optional(),
  names: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  current: RunStateSchema.optional(),
})

type ProgramsFile = z.infer<typeof FileSchema>

export type ProgramFileOptions = {
  path: string
  now?: () => number // epoch ms
  random?: () => number
}

export class ProgramFile {
  private path: string
  private now: () => number
  private random: () => number
  private file: ProgramsFile

  constructor({ path, now = Date.now, random = Math.random }: ProgramFileOptions) {
    this.path = path
    this.now = now
    this.random = random
    this.file = this.load()
  }

  // A missing or broken file is a fresh one: everything in it is rebuildable
  // or a convenience (a run that is lost simply does not resume).
  private load(): ProgramsFile {
    try {
      const parsed = FileSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf-8')))
      if (parsed.success) return parsed.data
    } catch {
      // unreadable: fall through to a fresh file
    }
    return { names: {} }
  }

  // Best-effort, atomic: a failed write costs a resume or a re-deal, never the
  // radio.
  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`, 'utf-8')
      renameSync(tmp, this.path)
    } catch {
      // read-only home, a file in the directory's place
    }
  }

  // The weights in force, re-dealt first when the deal is RESHUFFLE_DAYS old.
  weights(): Record<ProgramId, number> {
    const at = this.file.shuffledAt
    if (this.file.weights === undefined || at === undefined || this.now() - at >= RESHUFFLE_DAYS * DAY_MS) {
      const deck: number[] = [...WEIGHTS]
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1))
        ;[deck[i], deck[j]] = [deck[j]!, deck[i]!]
      }
      this.file.weights = Object.fromEntries(PROGRAM_IDS.map((id, i) => [id, deck[i]!])) as Record<ProgramId, number>
      this.file.shuffledAt = this.now()
      this.save()
    }
    return { ...this.file.weights }
  }

  name(language: string, id: ProgramId): string | undefined {
    return this.file.names[language]?.[id]
  }

  setName(language: string, id: ProgramId, name: string): void {
    this.file.names[language] = { ...this.file.names[language], [id]: name }
    this.save()
  }

  run(): RunState | undefined {
    return this.file.current
  }

  saveRun(run: RunState | undefined): void {
    if (run === undefined) delete this.file.current
    else this.file.current = run
    this.save()
  }
}
