import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ProfileBootstrap } from '../src/setup/cc-tools.ts'
import type { Brain, SeedAnswer, Task } from '../src/contracts.ts'
import { quitLatch } from '../src/setup/guide.ts'
import { isFirstRun, type ProfileWritable, runFirstRun, runProfileBootstrap } from '../src/setup/first-run.ts'
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

  async seedPersona(answers: readonly SeedAnswer[], language: string): Promise<string> {
    this.calls.push(answers)
    this.languages.push(language)
    if (this.fail) throw new Error('brain down')
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
    for (const q of SEED_QUESTIONS) {
      expect(host.asks).toContainEqual({ text: q, kind: 'question' })
    }
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

  it('a closed stdin declines every question instead of wedging startup', async () => {
    const { memoryDir, seed, home } = workspace()
    const brain = new FakeSeeder()
    const host = scriptedHost([], { eof: true })
    const path = await runFirstRun(deps({ host, brain, memoryDir, fallbackSeedPath: seed }))
    expect(path).toBe(home)
    expect(readFileSync(home, 'utf-8')).toBe(SEED_TEXT)
    expect(brain.calls).toHaveLength(0)
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

  for (const [name, reply] of [
    ['declining', 'n'],
    ['a stray line', 'maybe later'],
    ['an empty line', ''],
  ] as const) {
    it(`${name} runs no harness task at all`, async () => {
      const { memoryDir, seed } = workspace()
      const harness = new FakeHarness()
      await runFirstRun(deps({ host: scriptedHost([...answered(), reply]), harness, memoryDir, fallbackSeedPath: seed }))
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
  })
})

// Everything the user saw, wherever the front-end put it.
function everythingSaid(host: FakeHost): string {
  return [...host.infos, ...host.asks.map((a) => a.text)].join('\n')
}

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
