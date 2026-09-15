import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { ProfileBootstrap } from '../src/setup/cc-tools.ts'
import type { Brain, SeedAnswer, Task } from '../src/contracts.ts'
import { quitLatch } from '../src/setup/guide.ts'
import { isFirstRun, type ProfileWritable, runFirstRun, runProfileBootstrap, SEED_PERSONA_TIMEOUT_MS } from '../src/setup/first-run.ts'
import { SOURCES_OFFER } from '../src/music/sources/flow.ts'
import { PERSONA_CHAR_CAP, SEED_QUESTIONS } from '../src/prompts/persona.ts'
import { callTool, FakeHarness, FakeHost } from './fakes.ts'

const SEED_TEXT = 'bundled seed persona'
const GENERATED = `You are a quiet late-night host.\n${'the character, at length. '.repeat(20)}`

function workspace(): { dir: string; memoryDir: string; seed: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-first-run-'))
  const seed = join(dir, 'seed.md')
  writeFileSync(seed, SEED_TEXT)
  const memoryDir = join(dir, 'memory')
  return { dir, memoryDir, seed, home: join(memoryDir, 'persona.md') }
}

class FakeSeeder implements Pick<Brain, 'seedPersona'> {
  calls: (readonly SeedAnswer[])[] = []
  languages: string[] = []
  result = GENERATED
  fail = false
  // The real seam under a stuck model call: never resolves on its own, and
  // rejects only when the caller's signal aborts it.
  hang = false

  async seedPersona(answers: readonly SeedAnswer[], language: string, signal?: AbortSignal): Promise<string> {
    this.calls.push(answers)
    this.languages.push(language)
    if (this.fail) throw new Error('brain down')
    if (this.hang) {
      return new Promise<string>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    return this.result
  }
}

class FakeProfileStore implements ProfileWritable {
  text = ''
  writes: string[] = []

  profile(): string {
    return this.text
  }

  writeProfile(text: string): void {
    this.writes.push(text)
    this.text = text
  }
}

// A host with the onboarding answers (and optionally the consent line) already
// typed. `eof` closes stdin instead — the non-interactive run, where every read
// resolves '' (spec 06 §2.1: a piped run declines every question).
function scriptedHost(lines: string[] = [], { eof = false } = {}): FakeHost {
  const host = new FakeHost()
  for (const line of lines) host.type(line)
  if (eof) host.endInput()
  return host
}

const deps = (over: Partial<Parameters<typeof runFirstRun>[0]>) => ({
  host: scriptedHost([]),
  brain: new FakeSeeder(),
  memory: new FakeProfileStore(),
  memoryDir: '',
  fallbackSeedPath: '',
  model: 'test-model',
  language: 'English',
  ...over,
})

describe('isFirstRun (spec 06 §2.1, criterion 1)', () => {
  it('is a first run only while the persona home is absent', () => {
    const { memoryDir, home } = workspace()
    expect(isFirstRun(memoryDir)).toBe(true)
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(home, 'a persona')
    expect(isFirstRun(memoryDir)).toBe(false)
  })
})

describe('onboarding (criterion 2)', () => {
  it('asks the three questions and writes the generated persona to the home', async () => {
    const { memoryDir, seed, home } = workspace()
    const host = scriptedHost(['call me Zach', 'company while I work', 'dry, in Chinese'])
    const brain = new FakeSeeder()

    const path = await runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed }))

    expect(path).toBe(home)
    expect(readFileSync(home, 'utf-8')).toBe(GENERATED.trim())
    expect(readFileSync(home, 'utf-8')).not.toBe(SEED_TEXT)
    // Seeds are marked questions (spec 10 §3.2-B): the TUI docks them, the
    // plain host prints them — FakeHost has the surface, so they land there.
    // The first question has nowhere to go back to; every later step says
    // /back is live (spec 06 §3.4) — on the card, where it is read, not only
    // in the intro.
    // Each seed also carries its place in the run (spec 10 §3.2-B): the number
    // on the card is the engine's step, never a count of asks the client saw.
    const of = SEED_QUESTIONS.length
    expect(host.asks[0]).toEqual({ text: SEED_QUESTIONS[0], kind: 'question', choices: { step: { at: 1, of } } })
    expect(host.asks[1]).toEqual({
      text: SEED_QUESTIONS[1],
      kind: 'question',
      choices: { back: true, step: { at: 2, of } },
    })
    expect(host.asks[2]).toEqual({
      text: SEED_QUESTIONS[2],
      kind: 'question',
      choices: { back: true, step: { at: 3, of } },
    })
    expect(brain.calls[0]!.map((a) => a.answer)).toEqual([
      'call me Zach',
      'company while I work',
      'dry, in Chinese',
    ])
  })

  // spec 06 §3.2: nothing in the source picks the host's language. The default
  // is decided once here, from the machine the listener is on, and the answers
  // override it.
  it('hands the detected language to the Brain as the default', async () => {
    const { memoryDir, seed } = workspace()
    const brain = new FakeSeeder()
    await runFirstRun(
      deps({
        host: scriptedHost(['a', 'b', 'c']),
        brain,
        memoryDir,
        fallbackSeedPath: seed,
        language: 'Japanese',
      }),
    )
    expect(brain.languages).toEqual(['Japanese'])
  })

  it('tells the user where the persona lives, since editing it is the only way it changes', async () => {
    const { memoryDir, seed, home } = workspace()
    const host = scriptedHost(['a', 'b', 'c'])
    await runFirstRun(deps({ host, memoryDir, fallbackSeedPath: seed }))
    expect(host.infos.join('\n')).toContain(home)
  })
})

describe('skip and non-interactive (criterion 3)', () => {
  it('all-empty answers fall through to the bundled seed with no Brain call', async () => {
    const { memoryDir, seed, home } = workspace()
    const brain = new FakeSeeder()
    const path = await runFirstRun(
      deps({ host: scriptedHost(['', '', '']), brain, memoryDir, fallbackSeedPath: seed }),
    )
    expect(path).toBe(home)
    expect(readFileSync(home, 'utf-8')).toBe(SEED_TEXT)
    expect(brain.calls).toHaveLength(0)
  })

  // The skipped path is the one with no answers to read a language out of, so
  // it is the one that must not leave a raw slot in the listener's persona.
  it('fills the bundled seed language slot on the way to the home', async () => {
    const { dir, memoryDir, home } = workspace()
    const seed = join(dir, 'slotted.md')
    writeFileSync(seed, 'You are a host.\n- Always speak in {{language}}.\n')
    const path = await runFirstRun(
      deps({ host: scriptedHost(['', '', '']), memoryDir, fallbackSeedPath: seed, language: 'Japanese' }),
    )
    expect(path).toBe(home)
    expect(readFileSync(home, 'utf-8')).toContain('Always speak in Japanese.')
    expect(readFileSync(home, 'utf-8')).not.toContain('{{')
  })

  // spec 06 §3.4: three Enters are three answers a live listener chose not to
  // give, not a host that went away — and that listener is exactly the one the
  // consent cards are there for.
  it('three empty typed lines still reach both consent cards, on the bundled seed', async () => {
    const { memoryDir, seed, home } = workspace()
    const brain = new FakeSeeder()
    const harness = new FakeHarness()
    let sources = 0
    const host = scriptedHost(['', '', '', 'y', 'n'])
    const path = await runFirstRun(
      deps({ host, brain, harness, memoryDir, fallbackSeedPath: seed, sourcesRecall: async () => void sources++ }),
    )
    const consents = host.asks.filter((a) => a.kind === 'consent')
    expect(consents).toHaveLength(2)
    expect(consents[0]!.text).toContain('Claude Code history')
    expect(consents[1]!.text).toBe(SOURCES_OFFER.join('\n'))
    expect(path).toBe(home)
    expect(readFileSync(home, 'utf-8')).toBe(SEED_TEXT)
    expect(brain.calls).toHaveLength(0)
    expect(host.infos.some((l) => l.includes('no answers'))).toBe(true)
    expect(sources).toBe(0)
    // A yes to slice B launches on the bundled-seed path too: no persona was
    // written, but the listener still said yes.
    await new Promise((r) => setImmediate(r))
    expect(harness.calls).toBe(1)
  })

  it('/quit at a card after three empty lines leaves: no persona marker, no bootstrap', async () => {
    const { memoryDir, seed, home } = workspace()
    const harness = new FakeHarness()
    const quit = quitLatch()
    const host = scriptedHost(['', '', '', '/quit'])
    const path = await runFirstRun(deps({ host, harness, memoryDir, fallbackSeedPath: seed, quit }))
    expect(quit.requested).toBe(true)
    expect(path).toBe(seed)
    expect(existsSync(home)).toBe(false)
    await new Promise((r) => setImmediate(r))
    expect(harness.calls).toBe(0)
  })

  // codex review: a yes taken back with /back and never re-answered is not
  // consent. If the host then goes away at the seed question, the early exit
  // must not launch what the listener walked back from.
  it('a yes walked back, then EOF, launches nothing', async () => {
    const { memoryDir, seed } = workspace()
    const harness = new FakeHarness()
    const host = scriptedHost(['', '', '', 'y', '/back', '/back'])
    // stdin closes once the scripted lines are spent: the re-asked seed
    // question is answered by EOF, not by a listener.
    let taken = 0
    const takeLine = host.takeLine.bind(host)
    host.takeLine = () => {
      const line = takeLine()
      if (line !== undefined && ++taken === 6) host.endInput()
      return line
    }
    await runFirstRun(
      deps({ host, harness, memoryDir, fallbackSeedPath: seed, sourcesRecall: async () => {} }),
    )
    await new Promise((r) => setImmediate(r))
    expect(harness.calls).toBe(0)
  })

  it('a closed stdin declines every question instead of wedging startup', async () => {
    const { memoryDir, seed, home } = workspace()
    const brain = new FakeSeeder()
    const harness = new FakeHarness()
    let sources = 0
    const host = scriptedHost([], { eof: true })
    const path = await runFirstRun(
      deps({ host, brain, harness, memoryDir, fallbackSeedPath: seed, sourcesRecall: async () => void sources++ }),
    )
    expect(path).toBe(home)
    expect(readFileSync(home, 'utf-8')).toBe(SEED_TEXT)
    expect(brain.calls).toHaveLength(0)
    // The host is gone: no card is asked of nobody, and nothing is launched.
    expect(host.asks.filter((a) => a.kind === 'consent')).toHaveLength(0)
    expect(sources).toBe(0)
    await new Promise((r) => setImmediate(r))
    expect(harness.calls).toBe(0)
  })

  it('a partially answered onboarding still seeds (one answer is enough)', async () => {
    const { memoryDir, seed } = workspace()
    const brain = new FakeSeeder()
    await runFirstRun(deps({ host: scriptedHost(['', 'late-night talk', '']), brain, memoryDir, fallbackSeedPath: seed }))
    expect(brain.calls).toHaveLength(1)
  })
})

describe('failure degrades to the bundled seed (criterion 4)', () => {
  const cases: [string, (brain: FakeSeeder) => void][] = [
    ['a throwing seedPersona', (b) => (b.fail = true)],
    ['an empty result', (b) => (b.result = '   ')],
    ['a degenerate one-liner', (b) => (b.result = 'ok!')],
  ]

  for (const [name, arrange] of cases) {
    it(`${name} falls back with an info line and no crash`, async () => {
      const { memoryDir, seed, home } = workspace()
      const brain = new FakeSeeder()
      arrange(brain)
      const host = scriptedHost(['a', 'b', 'c'])
      const path = await runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed }))
      expect(path).toBe(home)
      expect(readFileSync(home, 'utf-8')).toBe(SEED_TEXT)
      expect(host.infos.length).toBeGreaterThan(0)
    })
  }

  it('caps an oversized persona on the way to disk, and says so (codex review)', async () => {
    // persona.md becomes the stable prefix of every later Brain call, so a
    // model that overshoots the cap must not cost latency on every beat until
    // someone hand-edits the file.
    const { memoryDir, seed, home } = workspace()
    const brain = new FakeSeeder()
    brain.result = 'A'.repeat(PERSONA_CHAR_CAP * 3)
    const host = scriptedHost(['a', 'b', 'c'])
    const path = await runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed }))
    expect(path).toBe(home)
    expect(readFileSync(home, 'utf-8')).toHaveLength(PERSONA_CHAR_CAP)
    expect(host.infos.join('\n')).toMatch(/trimmed/i)
  })

  it('an unwritable persona home still boots the radio on the bundled seed', async () => {
    const { memoryDir, seed, home } = workspace()
    mkdirSync(memoryDir, { recursive: true })
    // Both the atomic temp file and the home itself are directories: every
    // write below fails, so the seed path is returned unchanged.
    mkdirSync(`${home}.tmp`)
    mkdirSync(home)
    const path = await runFirstRun(deps({ host: scriptedHost(['a', 'b', 'c']), memoryDir, fallbackSeedPath: seed }))
    expect(path).toBe(seed)
  })
})

describe('slice B consent gate (criterion 6)', () => {
  const answered = () => ['call me Zach', 'company', 'dry']

  it('accepting runs exactly one bootstrap task', async () => {
    const { memoryDir, seed } = workspace()
    const harness = new FakeHarness()
    await runFirstRun(deps({ host: scriptedHost([...answered(), 'y']), harness, memoryDir, fallbackSeedPath: seed }))
    expect(harness.calls).toBe(1)
  })

  for (const [name, replies] of [
    ['declining', ['n']],
    // A stray line re-asks the card instead of counting as a no (§3.4).
    ['a stray line then a decline', ['maybe later', 'n']],
    ['an empty line', ['']],
  ] as const) {
    it(`${name} runs no harness task at all`, async () => {
      const { memoryDir, seed } = workspace()
      const harness = new FakeHarness()
      await runFirstRun(deps({ host: scriptedHost([...answered(), ...replies]), harness, memoryDir, fallbackSeedPath: seed }))
      expect(harness.calls).toBe(0)
    })
  }

  it('a closed stdin never reaches the offer at all', async () => {
    const { memoryDir, seed } = workspace()
    const harness = new FakeHarness()
    const host = scriptedHost([], { eof: true })
    await runFirstRun(deps({ host, harness, memoryDir, fallbackSeedPath: seed }))
    expect(harness.calls).toBe(0)
    expect(everythingSaid(host)).not.toContain('Claude Code history')
  })

  it('no harness (no real brain) means the offer is never made', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost([...answered(), 'y'])
    await runFirstRun(deps({ host, memoryDir, fallbackSeedPath: seed }))
    expect(everythingSaid(host)).not.toContain('Claude Code history')
  })

  it('ships the offer as ONE consent ask: question first, the why-lines riding as card notes', async () => {
    // Ref B2: the question leads, "why murmur dares to ask" and "skipping is
    // fine" live INSIDE the card as quiet notes — one ask, no separate infos.
    const { memoryDir, seed } = workspace()
    const host = scriptedHost([...answered(), 'n'])
    await runFirstRun(deps({ host, harness: new FakeHarness(), memoryDir, fallbackSeedPath: seed }))
    const consent = host.asks.find((a) => a.kind === 'consent')
    const lines = consent?.text.split('\n') ?? []
    expect(lines[0]).toContain('Claude Code history')
    expect(lines[0]).toContain('[y/N]')
    expect(consent?.text).toContain('stay on this machine')
    expect(host.infos.join('\n')).not.toContain('Claude Code history')
    // A consent card is never the first step: /back is live on it.
    expect(consent?.choices).toEqual({ back: true })
  })
})

// Everything the user saw, wherever the front-end put it.
function everythingSaid(host: FakeHost): string {
  return [...host.infos, ...host.asks.map((a) => a.text)].join('\n')
}

describe('the persona call can be left or can time out (spec 06 §3.4)', () => {
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
  }

  it('a /quit fired while the call hangs returns the fallback at once, and writes no marker', async () => {
    const { memoryDir, seed, home } = workspace()
    const brain = new FakeSeeder()
    brain.hang = true
    const quit = quitLatch()
    const run = runFirstRun(deps({ host: scriptedHost(['a', 'b', 'c']), brain, memoryDir, fallbackSeedPath: seed, quit }))
    await settle()
    expect(brain.calls).toHaveLength(1)
    const started = Date.now()
    quit.fire()
    const path = await run
    expect(Date.now() - started).toBeLessThan(1000)
    // Leaving is not answering: the next boot asks again from the top.
    expect(path).toBe(seed)
    expect(existsSync(home)).toBe(false)
  })

  it('a call that outlives the timeout degrades to the bundled seed, with a marker and a word', async () => {
    vi.useFakeTimers()
    try {
      const { memoryDir, seed, home } = workspace()
      const brain = new FakeSeeder()
      brain.hang = true
      const host = scriptedHost(['a', 'b', 'c'])
      const run = runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed }))
      await vi.advanceTimersByTimeAsync(SEED_PERSONA_TIMEOUT_MS)
      const path = await run
      expect(path).toBe(home)
      expect(readFileSync(home, 'utf-8')).toContain(SEED_TEXT)
      expect(host.infos.some((m) => m.includes('took too long'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('/quit during first-run (codex review: leaving is not answering)', () => {
  it('writes NO persona marker, so the next boot asks again', async () => {
    const { memoryDir, seed, home } = workspace()
    const host = scriptedHost(['/quit'])
    const brain = new FakeSeeder()
    const quit = quitLatch()
    const path = await runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed, quit }))
    expect(quit.requested).toBe(true)
    // The bundled seed is USED this run but never copied home: persona.md
    // absent = first-run still pending.
    expect(path).toBe(seed)
    expect(existsSync(home)).toBe(false)
    expect(brain.calls).toHaveLength(0)
  })

  it('a caller without a latch gets the same exit: the fallback latch is the one the checks read', async () => {
    // With no deps.quit, lineReader still needs a latch — but an anonymous
    // inline one is invisible to the abandoned-conversation check below it,
    // which would then read the all-'' answers as "skip" and write the
    // persona marker a /quit must never leave behind.
    const { memoryDir, seed, home } = workspace()
    const host = scriptedHost(['/quit'])
    const brain = new FakeSeeder()
    const path = await runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed }))
    expect(path).toBe(seed)
    expect(existsSync(home)).toBe(false)
    expect(brain.calls).toHaveLength(0)
  })
})

describe('slice B execution (criteria 8 and 9)', () => {
  const bootstrapDeps = (over: Partial<Parameters<typeof runProfileBootstrap>[0]>) => ({
    harness: new FakeHarness(),
    memory: new FakeProfileStore(),
    host: new FakeHost(),
    model: 'test-model',
    ccRoot: '/nonexistent-cc-root',
    ...over,
  })

  const submitting = (profile: string) =>
    new FakeHarness(async (tools) => void (await callTool(tools, 'submit_profile', { profile })))

  it('writes the finished profile when the store is still empty', async () => {
    const memory = new FakeProfileStore()
    const ok = await runProfileBootstrap(bootstrapDeps({ harness: submitting('(About the listener)\na night owl'), memory }))
    expect(ok).toBe(true)
    expect(memory.text).toContain('night owl')
  })

  it('drops its result rather than clobbering a profile that formed mid-flight', async () => {
    // The real race (§2.4): empty when the task launches, written by compaction
    // while the radio was on air and the task was still reading.
    const memory = new FakeProfileStore()
    const racing = new FakeHarness(async (tools) => {
      memory.text = 'compaction got here first'
      await callTool(tools, 'submit_profile', { profile: 'bootstrapped' })
    })
    const ok = await runProfileBootstrap(bootstrapDeps({ harness: racing, memory }))
    expect(ok).toBe(false)
    expect(racing.calls).toBe(1)
    expect(memory.writes).toEqual([])
    expect(memory.text).toBe('compaction got here first')
  })

  it('never reads the history at all when a profile already exists (codex review)', async () => {
    // The apply-time guard alone would still have read private transcripts and
    // spent a model call to produce a result that could never be written.
    const memory = new FakeProfileStore()
    memory.text = 'compaction got here first'
    const harness = submitting('bootstrapped')
    expect(await runProfileBootstrap(bootstrapDeps({ harness, memory }))).toBe(false)
    expect(harness.calls).toBe(0)
    expect(memory.writes).toEqual([])
  })

  it('a turn-budget exhaustion or a thrown error writes nothing and never propagates', async () => {
    const exhausted = new FakeProfileStore()
    expect(await runProfileBootstrap(bootstrapDeps({ harness: new FakeHarness(), memory: exhausted }))).toBe(false)
    expect(exhausted.writes).toEqual([])

    const thrown = new FakeProfileStore()
    const angry = new FakeHarness(async () => {
      throw new Error('sdk exploded')
    })
    expect(await runProfileBootstrap(bootstrapDeps({ harness: angry, memory: thrown }))).toBe(false)
    expect(thrown.writes).toEqual([])
  })

  it('runs the task bounded, on the configured model, with the sandboxed reader tools', async () => {
    const harness = new FakeHarness()
    await runProfileBootstrap(bootstrapDeps({ harness, model: 'claude-opus-4-8' }))
    const task = harness.lastTask as Task<ProfileBootstrap>
    expect(task.model).toBe('claude-opus-4-8')
    expect(task.maxTurns).toBeGreaterThan(0)
    expect(task.maxTurns).toBeLessThanOrEqual(12)
    expect(task.tools(() => {}).map((t) => t.name)).toEqual([
      'list_sessions',
      'read_session',
      'read_instructions',
      'submit_profile',
    ])
  })

  it('is off the live loop: a bootstrap that never resolves does not hold up first run', async () => {
    const { memoryDir, seed, home } = workspace()
    const wedged = new FakeHarness(() => new Promise(() => {}))
    const path = await runFirstRun(
      deps({ host: scriptedHost(['a', 'b', 'c', 'y']), harness: wedged, memoryDir, fallbackSeedPath: seed }),
    )
    expect(path).toBe(home)
    expect(existsSync(home)).toBe(true)
  })
})

// spec 14 §3.9 / §5.11: the taste sources are offered as ONE consent card,
// once, on a real first run — after the slice-B consent, before the persona
// call — and a yes runs the /sources conversation itself. A run without the
// seam (no taste: a stub run) never sees the card.
describe('the sources offer (spec 14 §3.9)', () => {
  const answered = () => ['call me Zach', 'company', 'dry']
  const sourcesCard = (host: FakeHost) => host.asks.find((a) => a.kind === 'consent' && a.text === SOURCES_OFFER.join('\n'))

  it('a yes runs the /sources conversation, before the persona call', async () => {
    const { memoryDir, seed, home } = workspace()
    const host = scriptedHost([...answered(), 'y'])
    const brain = new FakeSeeder()
    let calls = 0
    let seedCallsWhenRun = -1
    const sourcesRecall = async () => {
      calls++
      seedCallsWhenRun = brain.calls.length
    }
    await runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed, sourcesRecall }))
    expect(calls).toBe(1)
    expect(seedCallsWhenRun).toBe(0)
    expect(brain.calls).toHaveLength(1)
    expect(existsSync(home)).toBe(true)
  })

  it('ships as one consent card: the question leads, two quiet notes ride along, no info line', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost([...answered(), 'n'])
    await runFirstRun(deps({ host, memoryDir, fallbackSeedPath: seed, sourcesRecall: async () => {} }))
    expect(host.asks.filter((a) => a.kind === 'consent').map((a) => a.choices)).toEqual([{ back: true }])
    const card = sourcesCard(host)
    const lines = card?.text.split('\n') ?? []
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/\? \[y\/N\]$/)
    expect(card?.text).toContain('/sources')
    expect(host.infos.join('\n')).not.toContain('/sources')
  })

  for (const [name, replies] of [
    ['declining', ['n']],
    // A stray line is never silently a no: the card comes back and the next
    // line is what answers it (spec 06 §3.4).
    ['a stray line then a decline', ['maybe later', 'n']],
    ['an empty line', ['']],
  ] as const) {
    it(`${name} runs nothing and writes nothing`, async () => {
      const { memoryDir, seed, home } = workspace()
      const memory = new FakeProfileStore()
      let calls = 0
      const host = scriptedHost([...answered(), ...replies])
      await runFirstRun(deps({ host, memory, memoryDir, fallbackSeedPath: seed, sourcesRecall: async () => void calls++ }))
      expect(calls).toBe(0)
      expect(memory.writes).toEqual([])
      // The persona still lands: declining the sources is not leaving.
      expect(existsSync(home)).toBe(true)
    })
  }

  it('a conversation that throws costs the connection, never the first run (codex review)', async () => {
    const { memoryDir, seed, home } = workspace()
    const host = scriptedHost([...answered(), 'y'])
    const brain = new FakeSeeder()
    const path = await runFirstRun(
      deps({ host, brain, memoryDir, fallbackSeedPath: seed, sourcesRecall: async () => { throw new Error('EACCES: sources.json.tmp') } }),
    )
    expect(path).toBe(home)
    expect(existsSync(home)).toBe(true)
    expect(brain.calls).toHaveLength(1)
    expect(host.infos.some((l) => l.includes('EACCES') && l.includes('/sources'))).toBe(true)
  })

  it('comes after the slice-B consent — every question asked, then one more', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost([...answered(), 'n', 'n'])
    await runFirstRun(deps({ host, harness: new FakeHarness(), memoryDir, fallbackSeedPath: seed, sourcesRecall: async () => {} }))
    const consents = host.asks.filter((a) => a.kind === 'consent')
    expect(consents).toHaveLength(2)
    expect(consents[0]!.text).toContain('Claude Code history')
    expect(consents[1]!.text).toBe(SOURCES_OFFER.join('\n'))
  })

  it('without the seam (a stub run, no taste) the card is never shown', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost([...answered(), 'y'])
    await runFirstRun(deps({ host, memoryDir, fallbackSeedPath: seed }))
    expect(sourcesCard(host)).toBeUndefined()
  })

  it('a closed stdin never reaches the card', async () => {
    const { memoryDir, seed } = workspace()
    let calls = 0
    const host = scriptedHost([], { eof: true })
    await runFirstRun(deps({ host, memoryDir, fallbackSeedPath: seed, sourcesRecall: async () => void calls++ }))
    expect(calls).toBe(0)
    expect(sourcesCard(host)).toBeUndefined()
  })

  it('/quit at the card leaves like /quit at the slice-B consent: no persona call, no marker', async () => {
    const { memoryDir, seed, home } = workspace()
    const host = scriptedHost([...answered(), '/quit'])
    const brain = new FakeSeeder()
    const quit = quitLatch()
    let calls = 0
    const path = await runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed, quit, sourcesRecall: async () => void calls++ }))
    expect(quit.requested).toBe(true)
    expect(calls).toBe(0)
    expect(brain.calls).toHaveLength(0)
    expect(path).toBe(seed)
    expect(existsSync(home)).toBe(false)
  })

  it('a /quit typed inside the /sources conversation ends the first run the same way', async () => {
    const { memoryDir, seed, home } = workspace()
    const quit = quitLatch()
    const host = scriptedHost([...answered(), 'y'])
    const brain = new FakeSeeder()
    // The conversation reads the latch's own /quit: modelled as the flow
    // returning after the listener left.
    const path = await runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed, quit, sourcesRecall: async () => quit.fire() }))
    expect(brain.calls).toHaveLength(0)
    expect(path).toBe(seed)
    expect(existsSync(home)).toBe(false)
  })
})

describe('the first run is a step table — /back walks it (spec 06 §3.2/§3.4)', () => {
  const answered = () => ['call me Zach', 'company', 'dry']
  const cards = (host: FakeHost) => host.asks.filter((a) => a.kind === 'consent').map((a) => a.text)
  const isSources = (text: string) => text === SOURCES_OFFER.join('\n')

  it('/back on the sources card returns to the bootstrap card', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost([...answered(), 'n', '/back', 'n', 'n'])
    await runFirstRun(
      deps({ host, harness: new FakeHarness(), memoryDir, fallbackSeedPath: seed, sourcesRecall: async () => {} }),
    )
    // bootstrap, sources, bootstrap again, sources again.
    expect(cards(host).map(isSources)).toEqual([false, true, false, true])
  })

  it('/back on the bootstrap card returns to the last seed question, the old answer riding along', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost([...answered(), '/back', 'warmer', 'n'])
    const brain = new FakeSeeder()
    await runFirstRun(deps({ host, brain, harness: new FakeHarness(), memoryDir, fallbackSeedPath: seed }))
    const questions = host.asks.filter((a) => a.kind === 'question')
    expect(questions).toHaveLength(4)
    expect(questions[3]!.text).toContain(SEED_QUESTIONS[2]!)
    expect(questions[3]!.text).toContain('dry')
    expect(brain.calls[0]!.map((a) => a.answer)).toEqual(['call me Zach', 'company', 'warmer'])
  })

  it('a yes taken back with /back is cancelled: the bootstrap never runs', async () => {
    const { memoryDir, seed } = workspace()
    const harness = new FakeHarness()
    const host = scriptedHost([...answered(), 'y', '/back', 'n', 'n'])
    await runFirstRun(
      deps({ host, harness, memoryDir, fallbackSeedPath: seed, sourcesRecall: async () => {} }),
    )
    await new Promise((r) => setImmediate(r))
    expect(harness.calls).toBe(0)
  })

  it('a consent card never reads a stray line as a no — it comes back', async () => {
    const { memoryDir, seed } = workspace()
    let calls = 0
    const host = scriptedHost([...answered(), 'maybe', 'y'])
    await runFirstRun(deps({ host, memoryDir, fallbackSeedPath: seed, sourcesRecall: async () => void calls++ }))
    expect(cards(host)).toEqual([SOURCES_OFFER.join('\n'), SOURCES_OFFER.join('\n')])
    expect(calls).toBe(1)
  })

  it('/back on the very first question does nothing', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost(['/back', ...answered()])
    const brain = new FakeSeeder()
    await runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed }))
    expect(brain.calls[0]!.map((a) => a.answer)).toEqual(answered())
  })
})

describe('/back during the seed questions (spec 06 §3.2)', () => {
  const questionAsks = (host: FakeHost) => host.asks.filter((a) => a.kind === 'question')

  it('re-asks the previous question with the old answer as a note, and the new answer replaces it', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost(['call me Zach', 'mostly music', '/back', 'company while I work', 'dry'])
    const brain = new FakeSeeder()
    await runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed }))
    const asks = questionAsks(host)
    // Q1, Q2, Q3, back to Q2 (carrying the note), then Q3 again.
    expect(asks.map((a) => a.text.split('\n')[0])).toEqual([
      SEED_QUESTIONS[0],
      SEED_QUESTIONS[1],
      SEED_QUESTIONS[2],
      SEED_QUESTIONS[1],
      SEED_QUESTIONS[2],
    ])
    expect(asks[3]!.text).toContain('mostly music')
    // A step walked back is the SAME step: its number goes down with it. A
    // client-side count of asks received would have called this one #4.
    expect(asks.map((a) => a.choices?.step)).toEqual([
      { at: 1, of: 3 },
      { at: 2, of: 3 },
      { at: 3, of: 3 },
      { at: 2, of: 3 },
      { at: 3, of: 3 },
    ])
    expect(brain.calls[0]!.map((a) => a.answer)).toEqual(['call me Zach', 'company while I work', 'dry'])
  })

  it('/back from the second question re-asks the first as step 1 of 3', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost(['zach', '/back', '', 'company while I work', 'dry'])
    const brain = new FakeSeeder()
    await runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed }))
    const asks = questionAsks(host)
    expect(asks[2]!.text).toContain(SEED_QUESTIONS[0]!)
    expect(asks[2]!.choices?.step).toEqual({ at: 1, of: 3 })
  })

  it('an empty line on the re-ask keeps the earlier answer', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost(['call me Zach', 'mostly music', '/back', '', 'dry'])
    const brain = new FakeSeeder()
    await runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed }))
    expect(brain.calls[0]!.map((a) => a.answer)).toEqual(['call me Zach', 'mostly music', 'dry'])
  })

  it('on the first question /back does nothing but ask it again', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost(['/back', 'call me Zach', 'company', 'dry'])
    const brain = new FakeSeeder()
    await runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed }))
    expect(questionAsks(host).map((a) => a.text)).toEqual([
      SEED_QUESTIONS[0],
      SEED_QUESTIONS[0],
      SEED_QUESTIONS[1],
      SEED_QUESTIONS[2],
    ])
    expect(brain.calls[0]!.map((a) => a.answer)).toEqual(['call me Zach', 'company', 'dry'])
  })

  it('the intro tells the listener /back exists', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost(['', '', ''])
    await runFirstRun(deps({ host, memoryDir, fallbackSeedPath: seed }))
    expect(host.infos[0]).toContain('/back')
  })
})

describe('the slice B offer comes before the persona call (spec 06 §3.4)', () => {
  const answered = () => ['call me Zach', 'company', 'dry']

  // The persona call is the long silent wait; the consent must be on screen
  // before it, not surface a minute later when the listener thinks it is over.
  it('asks for consent before seedPersona runs', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost([...answered(), 'y'])
    const harness = new FakeHarness()
    const brain = new FakeSeeder()
    let consentAskedBeforeSeed = false
    brain.seedPersona = async (answers, language) => {
      consentAskedBeforeSeed = host.asks.some((a) => a.kind === 'consent')
      return FakeSeeder.prototype.seedPersona.call(brain, answers, language)
    }
    await runFirstRun(deps({ host, brain, harness, memoryDir, fallbackSeedPath: seed }))
    expect(consentAskedBeforeSeed).toBe(true)
    expect(harness.calls).toBe(1)
  })

  it('the bootstrap still launches only once the persona is written: a failed seed runs none', async () => {
    const { memoryDir, seed } = workspace()
    const harness = new FakeHarness()
    const brain = new FakeSeeder()
    brain.fail = true
    await runFirstRun(deps({ host: scriptedHost([...answered(), 'y']), brain, harness, memoryDir, fallbackSeedPath: seed }))
    expect(harness.calls).toBe(0)
  })

  it('/quit at the consent prompt leaves without the persona call or a marker', async () => {
    const { memoryDir, seed, home } = workspace()
    const brain = new FakeSeeder()
    const harness = new FakeHarness()
    const quit = quitLatch()
    const path = await runFirstRun(
      deps({ host: scriptedHost([...answered(), '/quit']), brain, harness, memoryDir, fallbackSeedPath: seed, quit }),
    )
    expect(path).toBe(seed)
    expect(existsSync(home)).toBe(false)
    expect(brain.calls).toHaveLength(0)
    expect(harness.calls).toBe(0)
  })

  // codex review: with the consent already given, a /quit typed during the
  // persona wait sits in the queue with nobody reading it. Before, the consent
  // read consumed it; now the launch must not outlive the listener's leaving.
  it('a /quit typed during the persona wait stops the bootstrap and fires the latch', async () => {
    const { memoryDir, seed, home } = workspace()
    const host = scriptedHost([...answered(), 'y'])
    const harness = new FakeHarness()
    const brain = new FakeSeeder()
    const quit = quitLatch()
    brain.seedPersona = async (answers, language) => {
      host.type('/quit')
      return FakeSeeder.prototype.seedPersona.call(brain, answers, language)
    }
    const path = await runFirstRun(deps({ host, brain, harness, memoryDir, fallbackSeedPath: seed, quit }))
    expect(path).toBe(home)
    expect(quit.requested).toBe(true)
    expect(harness.calls).toBe(0)
    expect(host.takeLine()).toBeUndefined()
  })

  it('a latch fired during the persona wait also stops the bootstrap', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost([...answered(), 'y'])
    const harness = new FakeHarness()
    const brain = new FakeSeeder()
    const quit = quitLatch()
    brain.seedPersona = async (answers, language) => {
      quit.fire()
      return FakeSeeder.prototype.seedPersona.call(brain, answers, language)
    }
    await runFirstRun(deps({ host, brain, harness, memoryDir, fallbackSeedPath: seed, quit }))
    expect(harness.calls).toBe(0)
  })

  it('a line other than /quit typed during the wait is left for the radio', async () => {
    const { memoryDir, seed } = workspace()
    const host = scriptedHost([...answered(), 'y'])
    const harness = new FakeHarness()
    const brain = new FakeSeeder()
    brain.seedPersona = async (answers, language) => {
      host.type('hello there')
      return FakeSeeder.prototype.seedPersona.call(brain, answers, language)
    }
    await runFirstRun(deps({ host, brain, harness, memoryDir, fallbackSeedPath: seed }))
    expect(harness.calls).toBe(1)
    expect(host.takeLine()).toBe('hello there')
  })
})
