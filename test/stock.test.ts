// Stock lines (spec 04 §3.6): the opener set and the farewell the radio keeps
// on disk, so it speaks within a second of launch and signs off on the way out.
// Storage + fingerprint gate, the in-session refresh cadence, and the sign-off.

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AudioClip, ContextPack } from '../src/contracts.ts'
import {
  FAREWELL_TTL_MS,
  OPENER_BEATS,
  readStockSlot,
  signOff,
  StockLines,
  stockDir,
  writeStockSlot,
  type StockFingerprint,
  type StockRequest,
  type StockSet,
} from '../src/support/stock.ts'
import { buildNextTalkPrompt, buildNextTalksPrompt, buildStockLinesPrompt } from '../src/prompts/talk.ts'
import { emitStockLinesTool, stockLinesTask } from '../src/brain/talk-tools.ts'
import { callTool, FakeHarness, FakePlayer } from './fakes.ts'

const FP: StockFingerprint = { voice: 'hosted:ref-1', language: 'en', persona: 'p-hash' }

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'murmur-stock-'))
}

// A wav the provider just produced: the slot writer copies it next to its json.
function clip(dir: string, name: string): AudioClip {
  const source = join(dir, name)
  writeFileSync(source, name)
  return { source, kind: 'talk' }
}

describe('stock storage (spec 04 §3.6)', () => {
  it('resolves under the cache root', () => {
    expect(stockDir({ MURMUR_HOME: '/tmp/mh' })).toBe('/tmp/mh/cache/stock')
  })

  it('a written slot reads back with its texts and its wavs', () => {
    const dir = tmp()
    const src = tmp()
    writeStockSlot(dir, 'opener', {
      texts: ['one', 'two', 'three'],
      previous: ['old'],
      fingerprint: FP,
      clips: [clip(src, 'a.wav'), clip(src, 'b.wav'), clip(src, 'c.wav')],
      generatedAt: new Date(1000).toISOString(),
    })
    const read = readStockSlot(dir, 'opener', FP)
    expect(read.map((b) => b.text)).toEqual(['one', 'two', 'three'])
    expect(read.map((b) => b.clip.source)).toEqual([
      join(dir, 'opener-1.wav'),
      join(dir, 'opener-2.wav'),
      join(dir, 'opener-3.wav'),
    ])
    // The copy stands on its own: the provider's temp clip may be gone by boot.
    rmSync(src, { recursive: true })
    expect(readFileSync(read[0]!.clip.source, 'utf8')).toBe('a.wav')
  })

  it('a fingerprint that does not match the run plays nothing', () => {
    const dir = tmp()
    const src = tmp()
    writeStockSlot(dir, 'farewell', {
      texts: ['bye'],
      previous: [],
      fingerprint: FP,
      clips: [clip(src, 'f.wav')],
      generatedAt: new Date(0).toISOString(),
    })
    expect(readStockSlot(dir, 'farewell', FP)).toHaveLength(1)
    expect(readStockSlot(dir, 'farewell', { ...FP, voice: 'other' })).toEqual([])
    expect(readStockSlot(dir, 'farewell', { ...FP, language: 'zh' })).toEqual([])
    expect(readStockSlot(dir, 'farewell', { ...FP, persona: 'changed' })).toEqual([])
  })

  it('a corrupt json, a missing file and a missing wav all degrade to nothing', () => {
    const dir = tmp()
    expect(readStockSlot(dir, 'opener', FP)).toEqual([])
    writeFileSync(join(dir, 'opener.json'), '{ not json')
    expect(readStockSlot(dir, 'opener', FP)).toEqual([])
    const src = tmp()
    writeStockSlot(dir, 'opener', {
      texts: ['one', 'two'],
      previous: [],
      fingerprint: FP,
      clips: [clip(src, 'a.wav'), clip(src, 'b.wav')],
      generatedAt: new Date(0).toISOString(),
    })
    rmSync(join(dir, 'opener-2.wav'))
    // The set is only as good as its audio: a gap in it is not a program.
    expect(readStockSlot(dir, 'opener', FP)).toEqual([])
  })
})

// A brain that answers the stock call with scripted lines, and a voice that
// writes a real wav per text so the writer has something to copy.
function fakeStockBrain(sets: StockSet[]) {
  const requests: StockRequest[] = []
  return {
    requests,
    async stockLines(req: StockRequest): Promise<StockSet | null> {
      requests.push(req)
      return sets.shift() ?? null
    },
  }
}

function fakeStockVoice() {
  const dir = tmp()
  let n = 0
  const synthesized: string[] = []
  return {
    synthesized,
    async synthesize(text: string): Promise<AudioClip> {
      synthesized.push(text)
      n += 1
      return clip(dir, `s${n}.wav`)
    },
  }
}

function stockAt(
  dir: string,
  brain: { stockLines(req: StockRequest): Promise<StockSet | null> },
  clock: { now: number },
  over: { fingerprint?: StockFingerprint | null } = {},
) {
  const voice = fakeStockVoice()
  const lines: string[] = []
  const stock = new StockLines({
    dir,
    brain,
    voice,
    fingerprint: () => (over.fingerprint === undefined ? FP : over.fingerprint),
    context: () => ({ persona: 'you are a host', profile: 'they like rain' }),
    now: () => clock.now,
    log: (m) => lines.push(m),
  })
  return { stock, voice, lines }
}

const SET: StockSet = { opener: ['hello one', 'hello two', 'hello three'], farewell: 'that is all' }

describe('StockLines refresh (spec 04 §3.6)', () => {
  it('the first poke writes both slots and logs the seam; a second poke is a no-op', async () => {
    const dir = tmp()
    const clock = { now: 5_000 }
    const brain = fakeStockBrain([SET])
    const { stock, voice, lines } = stockAt(dir, brain, clock)
    expect(stock.maybeRefresh()).toBe(true)
    await stock.settled()
    expect(brain.requests).toHaveLength(1)
    expect(brain.requests[0]).toMatchObject({ persona: 'you are a host', count: OPENER_BEATS, farewell: true })
    expect(voice.synthesized).toEqual(['hello one', 'hello two', 'hello three', 'that is all'])
    expect(readStockSlot(dir, 'opener', FP).map((b) => b.text)).toEqual(SET.opener)
    expect(readStockSlot(dir, 'farewell', FP).map((b) => b.text)).toEqual(['that is all'])
    expect(lines.some((l) => /^stock\.refresh opener=yes farewell=yes \d+ms$/.test(l))).toBe(true)
    // Once per session: the opener is already fresh for this run.
    expect(stock.maybeRefresh()).toBe(false)
    expect(brain.requests).toHaveLength(1)
  })

  it('carries the previous generation forward so the prompt can ask for something else', async () => {
    const dir = tmp()
    const clock = { now: 0 }
    const first = fakeStockBrain([SET])
    const a = stockAt(dir, first, clock)
    a.stock.maybeRefresh()
    await a.stock.settled()
    const second = fakeStockBrain([{ opener: ['x', 'y', 'z'], farewell: 'bye' }])
    const b = stockAt(dir, second, clock)
    b.stock.maybeRefresh()
    await b.stock.settled()
    expect(second.requests[0]!.previous).toEqual(SET.opener)
  })

  it('leaves a fresh farewell alone and refreshes it past the TTL', async () => {
    const dir = tmp()
    const clock = { now: 0 }
    const brain = fakeStockBrain([SET, { opener: ['a', 'b', 'c'] }, { opener: ['d', 'e', 'f'], farewell: 'later' }])
    stockAt(dir, brain, clock).stock.maybeRefresh()
    await new Promise((r) => setTimeout(r, 0))

    clock.now = FAREWELL_TTL_MS - 1
    const mid = stockAt(dir, brain, clock)
    mid.stock.maybeRefresh()
    await mid.stock.settled()
    expect(brain.requests[1]).toMatchObject({ farewell: false })
    expect(mid.lines.some((l) => l.startsWith('stock.refresh opener=yes farewell=no'))).toBe(true)
    expect(readStockSlot(dir, 'farewell', FP).map((b) => b.text)).toEqual(['that is all'])

    clock.now = FAREWELL_TTL_MS + 1
    const late = stockAt(dir, brain, clock)
    late.stock.maybeRefresh()
    await late.stock.settled()
    expect(brain.requests[2]).toMatchObject({ farewell: true })
    expect(readStockSlot(dir, 'farewell', FP).map((b) => b.text)).toEqual(['later'])
  })

  it('a stale farewell fingerprint is due however young it is', async () => {
    const dir = tmp()
    const clock = { now: 0 }
    const brain = fakeStockBrain([SET, { opener: ['a', 'b', 'c'], farewell: 'anew' }])
    const first = stockAt(dir, brain, clock)
    first.stock.maybeRefresh()
    await first.stock.settled()
    const other = { ...FP, voice: 'hosted:ref-2' }
    const next = stockAt(dir, brain, clock, { fingerprint: other })
    next.stock.maybeRefresh()
    await next.stock.settled()
    expect(brain.requests[1]).toMatchObject({ farewell: true })
    expect(readStockSlot(dir, 'farewell', other).map((b) => b.text)).toEqual(['anew'])
  })

  it('a farewell whose audio went missing is due however young its json is', async () => {
    const dir = tmp()
    const clock = { now: 0 }
    const brain = fakeStockBrain([SET, { opener: ['a', 'b', 'c'], farewell: 'again' }])
    const first = stockAt(dir, brain, clock)
    first.stock.maybeRefresh()
    await first.stock.settled()
    rmSync(join(dir, 'farewell-1.wav'))
    const next = stockAt(dir, brain, clock)
    next.stock.maybeRefresh()
    await next.stock.settled()
    expect(brain.requests[1]).toMatchObject({ farewell: true })
    expect(readStockSlot(dir, 'farewell', FP).map((b) => b.text)).toEqual(['again'])
  })

  it('a voice swapped under a running generation throws the round away', async () => {
    const dir = tmp()
    const src = tmp()
    // A playable set from the old voice, so there is something to protect.
    writeStockSlot(dir, 'opener', {
      texts: ['kept'],
      previous: [],
      fingerprint: FP,
      clips: [clip(src, 'k.wav')],
      generatedAt: new Date(0).toISOString(),
    })
    let fp: StockFingerprint = FP
    const voice = fakeStockVoice()
    const lines: string[] = []
    const stock = new StockLines({
      dir,
      brain: {
        async stockLines(): Promise<StockSet> {
          // The listener runs /setup and pins a different voice mid-call.
          fp = { ...FP, voice: 'hosted:ref-9' }
          return SET
        },
      },
      voice,
      fingerprint: () => fp,
      context: () => ({ persona: 'p', profile: '' }),
      now: () => 0,
      log: (m) => lines.push(m),
    })
    stock.maybeRefresh()
    await stock.settled()
    expect(lines.some((l) => l.startsWith('stock.refresh opener=no farewell=no'))).toBe(true)
    expect(readStockSlot(dir, 'opener', FP).map((b) => b.text)).toEqual(['kept'])
  })

  it('a copy that dies halfway leaves the old set playable rather than a mix', async () => {
    const dir = tmp()
    const src = tmp()
    writeStockSlot(dir, 'opener', {
      texts: ['kept one', 'kept two'],
      previous: [],
      fingerprint: FP,
      clips: [clip(src, 'k1.wav'), clip(src, 'k2.wav')],
      generatedAt: new Date(0).toISOString(),
    })
    expect(() =>
      writeStockSlot(dir, 'opener', {
        texts: ['new one', 'new two'],
        previous: [],
        fingerprint: FP,
        clips: [clip(src, 'n1.wav'), { source: join(src, 'gone.wav'), kind: 'talk' }],
        generatedAt: new Date(1).toISOString(),
      }),
    ).toThrow()
    const kept = readStockSlot(dir, 'opener', FP)
    expect(kept.map((b) => b.text)).toEqual(['kept one', 'kept two'])
    expect(readFileSync(kept[0]!.clip.source, 'utf8')).toBe('k1.wav')
  })

  it('is single-flight, and a failed generation leaves the files as they were', async () => {
    const dir = tmp()
    const clock = { now: 0 }
    const brain = {
      calls: 0,
      async stockLines(): Promise<StockSet | null> {
        brain.calls += 1
        await new Promise((r) => setTimeout(r, 5))
        return null
      },
    }
    const { stock, lines } = stockAt(dir, brain, clock)
    expect(stock.maybeRefresh()).toBe(true)
    expect(stock.maybeRefresh()).toBe(false)
    await stock.settled()
    expect(brain.calls).toBe(1)
    expect(readStockSlot(dir, 'opener', FP)).toEqual([])
    expect(lines.some((l) => l.startsWith('stock.refresh opener=no farewell=no'))).toBe(true)
  })

  it('never generates without a fingerprint (no persona to speak from)', async () => {
    const dir = tmp()
    const brain = fakeStockBrain([SET])
    const { stock } = stockAt(dir, brain, { now: 0 }, { fingerprint: null })
    expect(stock.maybeRefresh()).toBe(false)
    expect(stock.opener()).toEqual([])
    expect(stock.farewell()).toBeNull()
  })

  it('reads the boot opener and the farewell back through the same fingerprint gate', async () => {
    const dir = tmp()
    const brain = fakeStockBrain([SET])
    const { stock } = stockAt(dir, brain, { now: 0 })
    stock.maybeRefresh()
    await stock.settled()
    const fresh = stockAt(dir, fakeStockBrain([]), { now: 0 })
    expect(fresh.stock.opener().map((b) => b.text)).toEqual(SET.opener)
    expect(fresh.stock.farewell()?.source).toBe(join(dir, 'farewell-1.wav'))
    const swapped = stockAt(dir, fakeStockBrain([]), { now: 0 }, { fingerprint: { ...FP, language: 'zh' } })
    expect(swapped.stock.opener()).toEqual([])
    expect(swapped.stock.farewell()).toBeNull()
  })
})

describe('signOff (spec 04 §3.6)', () => {
  it('plays the farewell with the flush running concurrently and logs the seam', async () => {
    const player = new FakePlayer()
    player.auto = false
    const lines: string[] = []
    let flushed = false
    const done = signOff({
      clip: { source: '/fake/farewell.wav', kind: 'talk' },
      player,
      flush: async () => {
        flushed = true
      },
      log: (m) => lines.push(m),
    })
    await new Promise((r) => setTimeout(r, 0))
    // The flush did not wait for the farewell to finish.
    expect(flushed).toBe(true)
    expect(player.playing).toBe(true)
    player.finish()
    await done
    expect(player.played.map((c) => c.source)).toEqual(['/fake/farewell.wav'])
    expect(lines).toContain('stock.farewell aired')
  })

  it('with no farewell on disk it is exactly the flush, as today', async () => {
    const player = new FakePlayer()
    let flushed = false
    await signOff({
      clip: null,
      player,
      flush: async () => {
        flushed = true
      },
    })
    expect(flushed).toBe(true)
    expect(player.played).toEqual([])
  })

  it('a flush that throws never masks the sign-off', async () => {
    const player = new FakePlayer()
    await signOff({
      clip: { source: '/fake/farewell.wav', kind: 'talk' },
      player,
      flush: () => Promise.reject(new Error('fold blew up')),
    })
    expect(player.played).toHaveLength(1)
  })
})

describe('the stock prompt (spec 04 §3.6)', () => {
  const req: StockRequest = {
    persona: 'you are a host',
    profile: 'They like rain.\nThey work nights.',
    count: 3,
    farewell: true,
    previous: ['an older opener'],
  }

  it('stands on persona and profile alone and forbids anything time-bound', () => {
    const prompt = buildStockLinesPrompt(req)
    expect(prompt).toContain('They like rain.')
    expect(prompt).toContain('time of day')
    expect(prompt).toContain('how long they have been away')
    expect(prompt).toContain('complete stopping point')
    // Nothing about THIS moment reaches it: a stock line airs at an unknown
    // hour after an unknown gap.
    expect(prompt).not.toContain('The clock reads')
  })

  it('carries the previous set and asks for something different', () => {
    const prompt = buildStockLinesPrompt(req)
    expect(prompt).toContain('an older opener')
    expect(prompt).toContain('different')
  })

  it('asks for the farewell only when that slot is due', () => {
    expect(buildStockLinesPrompt(req)).toContain('sign-off')
    const fresh = buildStockLinesPrompt({ ...req, farewell: false })
    expect(fresh).not.toContain('sign-off')
    expect(fresh).toContain('3 opening beats')
  })

  it('renders nothing for an empty profile and an empty previous set', () => {
    const bare = buildStockLinesPrompt({ ...req, profile: '', previous: [] })
    expect(bare).not.toContain('What you know about the listener')
    expect(bare).not.toContain('Last time you said')
  })
})

describe('the emit_stock_lines tool (spec 04 §3.6)', () => {
  it('captures the trimmed set, capped at the count', async () => {
    let captured: StockSet | null = null
    const tool = emitStockLinesTool(2, true, (set) => (captured = set))
    await callTool([tool], 'emit_stock_lines', { opener: [' one ', 'two', 'three'], farewell: ' bye ' })
    expect(captured).toEqual({ opener: ['one', 'two'], farewell: 'bye' })
  })

  it('drops empty beats and captures nothing when none survive', async () => {
    let captured: StockSet | null = null
    const tool = emitStockLinesTool(3, false, (set) => (captured = set))
    await callTool([tool], 'emit_stock_lines', { opener: ['  ', ''] })
    expect(captured).toBeNull()
  })
})

describe('the stock task (spec 04 §3.6)', () => {
  it('runs in the host voice on the given tier and hands back the set', async () => {
    const harness = new FakeHarness(async (tools) => {
      await callTool(tools, 'emit_stock_lines', { opener: ['a', 'b', 'c'], farewell: 'bye' })
    })
    const req: StockRequest = { persona: 'you are a host', profile: '', count: 3, farewell: true, previous: [] }
    const set = await harness.runTask(stockLinesTask(req, 'claude-opus-5'))
    expect(set).toEqual({ opener: ['a', 'b', 'c'], farewell: 'bye' })
    expect(harness.lastTask?.model).toBe('claude-opus-5')
    expect(harness.lastTask?.systemPrompt).toContain('you are a host')
  })

  it('a turn budget that runs out without the terminal call is no stock at all', async () => {
    const harness = new FakeHarness()
    const req: StockRequest = { persona: 'p', profile: '', count: 3, farewell: false, previous: [] }
    expect(await harness.runTask(stockLinesTask(req, 'm'))).toBeNull()
  })
})

describe('the opening head after stock lines (spec 04 §3.6)', () => {
  const pack = (over: Partial<ContextPack> = {}): ContextPack => ({
    persona: 'p',
    recent: [{ role: 'radio', text: 'the stock opener' }],
    ...over,
  })

  it('a transcript of stock lines still carries the opening fact', () => {
    const prompt = buildNextTalksPrompt(pack({ opening: true }), 2)
    expect(prompt).toContain('The program is starting now.')
    expect(prompt).toContain('(Already on the air, just now)')
    expect(prompt).toContain('You: the stock opener')
    expect(prompt).not.toContain('(The program so far)')
    // The return fact still rides it when there was a gap (§3.5).
    const back = buildNextTalksPrompt(pack({ opening: true, lastOnAir: { when: 'yesterday', topics: [] } }), 2)
    expect(back).toContain('The program is coming back on now.')
  })

  it('once a live beat has answered them the head is the ordinary one', () => {
    const prompt = buildNextTalksPrompt(pack(), 2)
    expect(prompt).toContain('(The program so far)')
    expect(prompt).not.toContain('The program is starting now.')
  })

  it('the single-beat fallback builder opens the same way', () => {
    expect(buildNextTalkPrompt(pack({ opening: true }))).toContain('(Already on the air, just now)')
  })
})
