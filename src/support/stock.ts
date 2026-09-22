// Stock lines (spec 04 §3.6): the three opener beats and the one farewell the
// radio keeps on disk, so it can speak within a second of launch and sign off
// on the way out instead of stopping mid-air.
//
// One mechanism, two slots, under the cache root — regenerable audio, never
// listener data. Everything here is total: a missing, corrupt or stale file is
// silence, exactly like today, and nothing on this path may block boot or quit.

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import type { AudioClip, Player, VoiceProvider } from '../contracts.ts'
import { cacheRoot } from '../paths.ts'

// How many beats an opener set holds. Three is a by-ear starting point: enough
// to cover a cold batch that thinks, short enough that the program does not
// spend its whole opening on canned text.
export const OPENER_BEATS = 3

// The farewell is the same line for a while on purpose — a sign-off is a
// signature, not a fresh thought — but not forever.
export const FAREWELL_TTL_MS = 3 * 24 * 60 * 60 * 1000

export type StockSlot = 'opener' | 'farewell'

// What a stored slot was made FOR. A run whose voice, output language or
// persona differs from these does not play the file: the stock would be the
// wrong host. This is the whole invalidation story — no events, no wiring.
export type StockFingerprint = { voice: string; language: string; persona: string }

export type StockBeat = { text: string; clip: AudioClip }

const fingerprintSchema = z.object({ voice: z.string(), language: z.string(), persona: z.string() })

const fileSchema = z.object({
  texts: z.array(z.string()).min(1),
  previous: z.array(z.string()),
  generatedAt: z.string(),
  fingerprint: fingerprintSchema,
})

type StockFile = z.infer<typeof fileSchema>

export function stockDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheRoot(env), 'stock')
}

// The persona half of the fingerprint: the file's own bytes, so any edit — the
// first run's seed, a hand-tuned line — retires the stock that came from it.
export function personaFingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function jsonPath(dir: string, slot: StockSlot): string {
  return join(dir, `${slot}.json`)
}

function wavPath(dir: string, slot: StockSlot, index: number): string {
  return join(dir, `${slot}-${index + 1}.wav`)
}

// The file as stored, or null for anything that is not a slot this build
// understands. Parsed, never cast: the file is a trust boundary like any other.
export function readStockFile(dir: string, slot: StockSlot): StockFile | null {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(jsonPath(dir, slot), 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// The playable beats of a slot: [] when the file is absent, unreadable, made
// for a different run, or short an audio file. A set is only as good as its
// audio — a gap in the middle of it is not a program.
export function readStockSlot(dir: string, slot: StockSlot, fingerprint: StockFingerprint): StockBeat[] {
  const file = readStockFile(dir, slot)
  if (file === null) return []
  const fp = file.fingerprint
  if (fp.voice !== fingerprint.voice || fp.language !== fingerprint.language || fp.persona !== fingerprint.persona) {
    return []
  }
  const beats: StockBeat[] = []
  for (const [i, text] of file.texts.entries()) {
    const source = wavPath(dir, slot, i)
    try {
      readFileSync(source)
    } catch {
      return []
    }
    beats.push({ text, clip: { source, kind: 'talk' } })
  }
  return beats
}

export type StockWrite = {
  texts: readonly string[]
  previous: readonly string[]
  fingerprint: StockFingerprint
  // One freshly synthesized clip per text, in order. They are COPIED here: the
  // provider's temp directory goes away with the provider.
  clips: readonly AudioClip[]
  generatedAt: string
}

export function writeStockSlot(dir: string, slot: StockSlot, write: StockWrite): void {
  mkdirSync(dir, { recursive: true })
  for (const [i, clip] of write.clips.entries()) copyFileSync(clip.source, wavPath(dir, slot, i))
  const file: StockFile = {
    texts: [...write.texts],
    previous: [...write.previous],
    generatedAt: write.generatedAt,
    fingerprint: write.fingerprint,
  }
  writeFileSync(jsonPath(dir, slot), `${JSON.stringify(file, null, 2)}\n`)
}

// --- generation ----------------------------------------------------------- //

// What one generation asks for: the host's own framing, and the last set's
// texts so the prompt can ask for something else. `farewell` is false when
// that slot is still fresh — the call happens either way, but nothing is spent
// writing a line nobody will store.
export type StockRequest = {
  persona: string
  profile: string
  count: number
  farewell: boolean
  previous: readonly string[]
}

export type StockSet = { opener: readonly string[]; farewell?: string }

// The narrow brain seam: only the real (claude) brain implements it, which is
// what keeps a STUB=1 run free of stock by construction.
export interface StockBrain {
  stockLines(req: StockRequest): Promise<StockSet | null>
}

export type StockDeps = {
  dir: string
  brain: StockBrain
  voice: Pick<VoiceProvider, 'synthesize'>
  // What this run is: null when the persona cannot be read, which is a run
  // with nothing to generate from.
  fingerprint: () => StockFingerprint | null
  context: () => { persona: string; profile: string }
  now?: () => number
  log?: (message: string) => void
}

export class StockLines {
  private deps: StockDeps
  private refreshing: Promise<void> | null = null
  private refreshed = false

  constructor(deps: StockDeps) {
    this.deps = deps
  }

  // The opener beats to air at boot, oldest decision first. [] = silence.
  opener(): StockBeat[] {
    const fp = this.deps.fingerprint()
    return fp === null ? [] : readStockSlot(this.deps.dir, 'opener', fp)
  }

  farewell(): AudioClip | null {
    const fp = this.deps.fingerprint()
    if (fp === null) return null
    return readStockSlot(this.deps.dir, 'farewell', fp)[0]?.clip ?? null
  }

  // Poked once, off the loop, right after the first live beat airs. Returns
  // whether this poke launched the generation. Single-flight and once per
  // session: the opener is due every run, so a second poke has nothing to do.
  maybeRefresh(): boolean {
    if (this.refreshed || this.refreshing !== null) return false
    if (this.deps.fingerprint() === null) return false
    this.refreshed = true
    this.refreshing = this.run().finally(() => (this.refreshing = null))
    return true
  }

  // Test seam: await whatever this instance launched.
  async settled(): Promise<void> {
    await this.refreshing
  }

  // Total: the stock is a nicety, and a failed generation must cost one log
  // line and nothing else. The files on disk are replaced only on success, so
  // a bad round leaves the previous set playable.
  private async run(): Promise<void> {
    const started = this.now()
    let opener = false
    let farewell = false
    try {
      const fp = this.deps.fingerprint()
      if (fp === null) return
      const { persona, profile } = this.deps.context()
      const wantFarewell = this.farewellDue(fp)
      const previous = readStockFile(this.deps.dir, 'opener')?.texts ?? []
      const set = await this.deps.brain.stockLines({
        persona,
        profile,
        count: OPENER_BEATS,
        farewell: wantFarewell,
        previous,
      })
      if (set === null) return
      const generatedAt = new Date(this.now()).toISOString()
      const texts = set.opener.filter((t) => t.trim() !== '').slice(0, OPENER_BEATS)
      if (texts.length > 0) {
        const clips = await this.synthesize(texts)
        if (clips !== null) {
          writeStockSlot(this.deps.dir, 'opener', { texts, previous, fingerprint: fp, clips, generatedAt })
          opener = true
        }
      }
      const line = wantFarewell ? set.farewell?.trim() : undefined
      if (line) {
        const clips = await this.synthesize([line])
        if (clips !== null) {
          const was = readStockFile(this.deps.dir, 'farewell')?.texts ?? []
          writeStockSlot(this.deps.dir, 'farewell', {
            texts: [line],
            previous: was,
            fingerprint: fp,
            clips,
            generatedAt,
          })
          farewell = true
        }
      }
    } catch (err) {
      this.deps.log?.(`stock.refresh failed (${String(err)})`)
    } finally {
      const ms = this.now() - started
      this.deps.log?.(`stock.refresh opener=${yesNo(opener)} farewell=${yesNo(farewell)} ${ms}ms`)
    }
  }

  // All of a slot's clips or none: a half-synthesized set would read back as
  // a gap and be thrown away at boot anyway.
  private async synthesize(texts: readonly string[]): Promise<AudioClip[] | null> {
    const clips: AudioClip[] = []
    for (const text of texts) {
      try {
        clips.push(await this.deps.voice.synthesize(text))
      } catch (err) {
        this.deps.log?.(`stock.refresh synthesis failed (${String(err)})`)
        return null
      }
    }
    return clips
  }

  private farewellDue(fp: StockFingerprint): boolean {
    const file = readStockFile(this.deps.dir, 'farewell')
    if (file === null) return true
    const f = file.fingerprint
    if (f.voice !== fp.voice || f.language !== fp.language || f.persona !== fp.persona) return true
    const at = Date.parse(file.generatedAt)
    return Number.isNaN(at) || this.now() - at >= FAREWELL_TTL_MS
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

// --- the sign-off --------------------------------------------------------- //

export type SignOff = {
  clip: AudioClip | null
  player: Pick<Player, 'play'>
  // The shutdown compaction flush (spec 05 §3.6), started alongside the
  // farewell rather than after it: its budget and the farewell's length are
  // the same wait, so the listener pays for one of them, not both.
  flush: () => Promise<void>
  log?: (message: string) => void
}

export async function signOff(deps: SignOff): Promise<void> {
  const flushing = deps.flush().catch(() => {})
  if (deps.clip !== null) {
    try {
      await deps.player.play(deps.clip)
      deps.log?.('stock.farewell aired')
    } catch {
      // a dead clip is silence, not a failed shutdown
    }
  }
  await flushing
}
