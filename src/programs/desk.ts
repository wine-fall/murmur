// The program desk (spec 15 §2.7): the run on the air and the one being
// prepared behind it. The Director asks it what point to say next and tells it
// what aired; everything about drawing, planning, cooldowns, names and resume
// lives here, so the talk loop only ever sees a cue.

import type { Harness, MemoryStore, ProgramCue } from '../contracts.ts'
import { PROGRAM_IDS, PROGRAMS, type Plan, type ProgramId, type RunState, TODAY_MIN_ITEMS } from './catalogue.ts'
import { planTask, type PlanRequest } from './plan.ts'
import { drawProgram, GAP, type ProgramFile } from './schedule.ts'
import { cooldownKeys } from './subject.ts'

// A run left unfinished this recently is picked up where it left off; older,
// it is dropped (what aired still counts for cooldown).
export const RESUME_WINDOW_MS = 6 * 3_600_000

// How many fresh real-world items a puzzle is shown, and a today takes.
const PUZZLE_ITEMS = 5
const TODAY_ITEMS = 3

// Planning calls per category before the draw moves on: a retry for a call
// that never submitted, a replan for a subject in cooldown.
const PLAN_ATTEMPTS = 2
// Categories tried per plan before the desk gives up for now.
const DRAW_ATTEMPTS = 3
// An outline shorter than this is not a program (and would plan its own
// successor before it had even opened).
const MIN_POINTS = 2

const DAY_S = 86_400

type Item = { readonly title: string; readonly gist: string }

export type DeskDeps = {
  file: ProgramFile
  memory: Pick<MemoryStore, 'recentPrograms' | 'recordProgram' | 'recordEvent'>
  harness: Harness
  model: string
  // Read per plan, so a persona or language change lands on the next one.
  persona: () => string
  // The spoken language's name: what the frozen program names are keyed by.
  language: () => string
  // The profile's About section and the taste digest, for the planner.
  about?: () => string
  taste?: () => string
  // The real-world pool (spec 13), absent when the knob is off or unwired.
  rwt?: { fresh(): readonly Item[]; take(n: number): readonly Item[] }
  rwtEnabled?: () => boolean
  now?: () => number // epoch ms
  random?: () => number
  log?: (message: string) => void
}

type Request = { id: ProgramId; subject?: string }

export class ProgramDesk {
  private deps: DeskDeps
  private now: () => number
  private run: RunState | null = null
  // The first point said after a relaunch carries the resume line.
  private resumed = false
  // The plan being prepared behind the run, and whether it has settled. An
  // epoch drops a plan a request has since superseded.
  private upcoming: Promise<RunState | null> | null = null
  private planned: RunState | null = null
  private epoch = 0

  constructor(deps: DeskDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    const saved = deps.file.run()
    if (saved !== undefined && saved.next < saved.plan.points.length && this.now() - saved.updatedAt < RESUME_WINDOW_MS) {
      this.run = saved
      this.resumed = saved.opened
      this.log(`program.resume ${saved.id} at ${saved.next + 1}/${saved.plan.points.length}`)
    } else if (saved !== undefined) {
      deps.file.saveRun(undefined)
    }
  }

  // The run on the air, promoting a prepared plan into an empty slot.
  current(): RunState | null {
    if (this.run === null && this.planned !== null) {
      this.run = this.planned
      this.planned = null
      this.upcoming = null
      this.persist()
      this.log(`program.on ${this.run.id} points=${this.run.plan.points.length}`)
    }
    return this.run
  }

  // Start preparing the next program, unless one is on the air, ready, or in
  // the works.
  ensure(): void {
    if (this.current() !== null || this.upcoming !== null) return
    this.prepare()
  }

  // Resolves once the plan in the works has settled (a run, or nothing).
  async ready(): Promise<void> {
    await this.upcoming
    this.current()
  }

  // Whether a plan is being prepared right now.
  planning(): boolean {
    return this.upcoming !== null && this.planned === null
  }

  // The point to say next, with its flags. Writing the last point is the
  // moment the next program starts being prepared, so no air goes dead
  // between them.
  cue(flags: Pick<ProgramCue, 'returning' | 'afterSong' | 'anchor'>): ProgramCue | null {
    const run = this.current()
    if (run === null) return null
    const { plan, next: index } = run
    const total = plan.points.length
    const point = plan.points[index]!
    if (index === total - 1 && this.upcoming === null) this.prepare()
    return {
      name: plan.name,
      subject: plan.subject,
      angle: plan.angle,
      outline: plan.points.map((p) => p.title),
      index,
      point: { title: point.title, content: point.content },
      beats: PROGRAMS[run.id].beats,
      ...(index === 0 && { opening: true as const }),
      ...(index === total - 1 && { closing: true as const }),
      ...(this.resumed && { resumed: true as const }),
      ...(flags.returning === true && { returning: true as const }),
      ...(flags.afterSong === true && { afterSong: true as const }),
      ...(flags.anchor !== undefined && index === 0 && { anchor: flags.anchor }),
    }
  }

  // The program's first beat aired: from here it counts in the play record.
  opened(): void {
    const run = this.run
    if (run === null || run.opened) return
    this.run = { ...run, opened: true }
    const leads = run.id === 'puzzle' ? run.plan.leads : undefined
    this.deps.memory.recordProgram({
      id: run.id,
      label: run.plan.subject,
      keys: cooldownKeys(run.id, run.plan),
      ...(leads !== undefined && { leads }),
      ...(run.requested && { requested: true }),
    })
    this.persist()
  }

  // The last beat of point `index` aired. Past the last point the program is
  // over and the slot is free for the one prepared behind it.
  pointAired(index: number): void {
    const run = this.run
    if (run === null || index !== run.next) return
    this.resumed = false
    const next = index + 1
    if (next >= run.plan.points.length) {
      this.log(`program.end ${run.id}`)
      this.run = null
      this.deps.file.saveRun(undefined)
      return
    }
    this.run = { ...run, next }
    this.persist()
  }

  // The listener asked for a program (spec 15 §2.8): the run on the air ends
  // now — its unsaid points are dropped — and the request is planned at once.
  // False = it cannot air right now (a today without its items); nothing
  // changes and the reply says so.
  request(id: ProgramId, subject?: string): boolean {
    if (!this.eligible(id)) return false
    this.reset()
    this.prepare({ id, ...(subject !== undefined && { subject }) })
    return true
  }

  // Drop the run on the air, the plan behind it and the persisted copy. A
  // forget (spec 05-01 §3.5) lands here: an outline is a copy of what the
  // planner was told, and nothing a listener erased may come back from it.
  reset(): void {
    this.epoch++
    this.run = null
    this.resumed = false
    this.planned = null
    this.upcoming = null
    this.deps.file.saveRun(undefined)
  }

  // `name - subject - n/total` (middle-dot separated) for the status line, while a program is on.
  label(): string | undefined {
    const run = this.run
    if (run === null) return undefined
    const total = run.plan.points.length
    return `${run.plan.name} · ${run.plan.subject} · ${Math.min(run.next + 1, total)}/${total}`
  }

  // What the next pick is told (spec 15 §2.10): a record asks for the track
  // its current point plays, as a request; the others only lend a mood.
  // `afterPoint` = the song that follows the point just aired, which `next`
  // has already moved past.
  musicHint(afterPoint = false): { line: string; request: boolean } | undefined {
    const run = this.run
    if (run === null) return undefined
    const track = run.plan.points[afterPoint ? run.next - 1 : run.next]?.track
    if (run.id === 'record' && track !== undefined) {
      return { line: `- the program on the air plays this track next: ${track.artist} — ${track.title}`, request: true }
    }
    return {
      line: `- the program on the air: ${run.plan.name} — ${run.plan.subject} (let it colour the mood, nothing more)`,
      request: false,
    }
  }

  private prepare(request?: Request): void {
    const epoch = ++this.epoch
    const work = this.plan(epoch, request).then(
      (run) => {
        if (epoch !== this.epoch) return null
        this.planned = run
        if (run === null) this.upcoming = null // nothing came of it: the next ensure() tries again
        return run
      },
      (err: unknown) => {
        this.log(`program.plan failed (${String(err)})`)
        if (epoch === this.epoch) this.upcoming = null
        return null
      },
    )
    this.upcoming = work
  }

  // Every step checks the epoch first: a plan a request or a forget has
  // superseded spends no further call and changes nothing on the way out.
  private async plan(epoch: number, request?: Request): Promise<RunState | null> {
    if (request !== undefined) return this.planOne(epoch, request.id, request.subject, true)
    const tried = new Set<ProgramId>()
    for (let draw = 0; draw < DRAW_ATTEMPTS && epoch === this.epoch; draw++) {
      const recent = this.deps.memory.recentPrograms(GAP).flatMap((r) => (isProgramId(r.id) ? [r.id] : []))
      const eligible = PROGRAM_IDS.filter((id) => !tried.has(id) && this.eligible(id))
      const id = drawProgram({
        weights: this.deps.file.weights(),
        recent,
        eligible,
        random: this.deps.random ?? Math.random,
      })
      if (id === null) return null
      const run = await this.planOne(epoch, id, undefined, false)
      if (run !== null) return run
      tried.add(id)
    }
    return null
  }

  private eligible(id: ProgramId): boolean {
    if (id !== 'today') return true
    return this.rwtOn() && (this.deps.rwt?.fresh().length ?? 0) >= TODAY_MIN_ITEMS
  }

  private rwtOn(): boolean {
    return this.deps.rwt !== undefined && (this.deps.rwtEnabled?.() ?? true)
  }

  // One category: up to PLAN_ATTEMPTS calls. A subject the listener named
  // bypasses the cooldown; otherwise a returned subject in cooldown is
  // replanned with it added to the avoid list.
  private async planOne(
    epoch: number,
    id: ProgramId,
    subject: string | undefined,
    requested: boolean,
  ): Promise<RunState | null> {
    const cooldown = this.cooldown(id)
    const avoid = [...cooldown.labels]
    const items = this.items(id)
    const language = this.deps.language()
    for (let attempt = 0; attempt < PLAN_ATTEMPTS && epoch === this.epoch; attempt++) {
      const name = this.deps.file.name(language, id)
      const req: PlanRequest = {
        id,
        persona: this.deps.persona(),
        // en-CA is the one locale whose short date is ISO YYYY-MM-DD, local.
        today: new Date(this.now()).toLocaleDateString('en-CA'),
        avoid,
        about: this.deps.about?.() ?? '',
        taste: this.deps.taste?.() ?? '',
        items,
        ...(name !== undefined && { name }),
        ...(subject !== undefined && { subject }),
      }
      const plan: Plan | null = await this.deps.harness.runTask(planTask(req, this.deps.model))
      if (epoch !== this.epoch) return null
      if (plan === null || plan.points.length < MIN_POINTS) {
        this.log(`program.plan ${id} returned no usable outline (attempt ${attempt + 1})`)
        continue
      }
      const keys = cooldownKeys(id, plan)
      // A dedupable program must be rememberable: a puzzle without its lead
      // thinkers would slip every cooldown.
      if (PROGRAMS[id].cooldownDays > 0 && keys.length === 0) {
        this.log(`program.plan ${id} returned no cooldown key (attempt ${attempt + 1})`)
        continue
      }
      const hit = subject === undefined && keys.some((k) => cooldown.keys.has(k))
      if (hit) {
        this.log(`program.plan ${id} subject in cooldown (attempt ${attempt + 1})`)
        avoid.push(...(id === 'puzzle' ? (plan.leads ?? []) : [plan.subject]))
        continue
      }
      if (name === undefined && plan.name !== '') this.deps.file.setName(language, id, plan.name)
      const frozen = this.deps.file.name(language, id) ?? plan.name
      return { id, plan: { ...plan, name: frozen }, next: 0, opened: false, requested, updatedAt: this.now() }
    }
    return null
  }

  // This category's subjects still in cooldown: the keys code matches, and
  // the labels the planner is told to avoid.
  private cooldown(id: ProgramId): { keys: Set<string>; labels: string[] } {
    const days = PROGRAMS[id].cooldownDays
    if (days === 0) return { keys: new Set(), labels: [] }
    const since = this.now() / 1000 - days * DAY_S
    const rows = this.deps.memory.recentPrograms(Number.MAX_SAFE_INTEGER).filter((r) => r.id === id && r.ts >= since)
    return {
      keys: new Set(rows.flatMap((r) => r.keys)),
      labels: [...new Set(rows.flatMap((r) => (id === 'puzzle' ? (r.leads ?? []) : [r.label])))],
    }
  }

  // Real-world material: a today TAKES its items (ledgered at the take, spec
  // 13 §3.7); a puzzle only looks.
  private items(id: ProgramId): readonly Item[] {
    if (!this.rwtOn()) return []
    if (id === 'puzzle') return this.deps.rwt!.fresh().slice(0, PUZZLE_ITEMS)
    if (id !== 'today') return []
    const taken = this.deps.rwt!.take(TODAY_ITEMS)
    for (const item of taken) this.deps.memory.recordEvent('rwt', item.title)
    return taken
  }

  private persist(): void {
    if (this.run === null) return
    this.run = { ...this.run, updatedAt: this.now() }
    this.deps.file.saveRun(this.run)
  }

  private log(message: string): void {
    this.deps.log?.(message)
  }
}

function isProgramId(id: string): id is ProgramId {
  return (PROGRAM_IDS as readonly string[]).includes(id)
}
