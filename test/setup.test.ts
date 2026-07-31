import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { GuideCapable, GuideRequest, LedgerKind } from '../src/contracts.ts'
import { detectGaps, runSetup, SETUP_DECLINED, type SetupLedger, type SetupTargets } from '../src/guide.ts'
import type { Host } from '../src/host.ts'
import { InProcessMemoryStore } from '../src/memory.ts'
import type { PreflightResult } from '../src/startup.ts'

const OK: PreflightResult = { ok: true, reason: '' }
const NO_YTDLP: PreflightResult = { ok: false, reason: "yt-dlp binary not found: 'yt-dlp'" }
const NO_BUN: PreflightResult = { ok: false, reason: "bun binary not found: 'bun'" }

function fakeHost(lines: string[] = [], { atEof = false } = {}): { host: Host; infos: string[] } {
  const infos: string[] = []
  const host: Host = {
    start: () => {},
    peekLine: () => (lines.length > 0 ? Promise.resolve(lines[0]!) : new Promise(() => {})),
    takeLine: () => lines.shift(),
    eof: () => (atEof ? Promise.resolve() : new Promise(() => {})),
    onRadioSegment: () => {},
    onUserLine: () => {},
    info: (m) => void infos.push(m),
    banner: () => {},
  }
  return { host, infos }
}

function fakeGuide(): { guide: GuideCapable; requests: GuideRequest[] } {
  const requests: GuideRequest[] = []
  return {
    requests,
    guide: {
      runGuide: async (req) => {
        requests.push(req)
        return 'explained.'
      },
    },
  }
}

// The narrow ledger surface setup needs — impl-level, like spec 06's
// ProfileWritable: the Director never reads or writes a setup record.
function fakeLedger(): SetupLedger & { events: { kind: LedgerKind; key: string }[] } {
  const store = new InProcessMemoryStore()
  const events: { kind: LedgerKind; key: string }[] = []
  return {
    events,
    recordEvent: (kind, key) => {
      events.push({ kind, key })
      store.recordEvent(kind, key)
    },
    recentEvents: (kind, n) => store.recentEvents(kind, n),
  }
}

const targets = (over: Partial<SetupTargets> = {}): SetupTargets => ({
  ytdlp: 'yt-dlp',
  ffmpeg: 'ffmpeg',
  bunCmd: 'bun',
  home: mkdtempSync(join(tmpdir(), 'murmur-setup-')),
  wantsMusic: true,
  wantsBun: true,
  wantsVoice: true,
  voiceUrl: () => '',
  ...over,
})

describe('detectGaps (spec 03-03 §7.1 — the deterministic probes, 0 tokens)', () => {
  it('names every gap the session actually has', async () => {
    const gaps = await detectGaps(targets(), { music: async () => NO_YTDLP, bun: async () => NO_BUN })
    expect(gaps.map((g) => g.kind)).toEqual(['music', 'bun', 'voice'])
    expect(gaps[0]!.reason).toContain('yt-dlp')
  })

  it('probes nothing the session does not want', async () => {
    let probed = 0
    const gaps = await detectGaps(
      targets({ wantsMusic: false, wantsBun: false, wantsVoice: false }),
      {
        music: async () => {
          probed++
          return NO_YTDLP
        },
        bun: async () => {
          probed++
          return NO_BUN
        },
      },
    )
    expect(gaps).toEqual([])
    expect(probed).toBe(0)
  })

  it('a configured endpoint is not a gap, wherever it came from', async () => {
    const gaps = await detectGaps(targets({ voiceUrl: () => 'https://tts.example' }), {
      music: async () => OK,
      bun: async () => OK,
    })
    expect(gaps).toEqual([])
  })
})

// The posture that matters (spec 03-03 §7.1 point 3): a degraded launch is NOT
// passive. Gaps open a real conversation, once per boot. Only an explicit
// decline, recorded on the tier-3 ledger, turns later boots quiet.
describe('runSetup — the once-per-boot offer', () => {
  const probes = { music: async () => NO_YTDLP, bun: async () => OK }

  it('actively opens the conversation and walks the guide through every gap', async () => {
    const { host, infos } = fakeHost(['y'])
    const { guide, requests } = fakeGuide()
    await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false }),
      ledger: fakeLedger(),
      probes,
    })
    expect(requests).toHaveLength(1)
    const req = requests[0]!
    // The preflight finding is the evidence that seeds the diagnosis.
    expect(req.prompt).toContain('yt-dlp')
    // Every consent seam is wired: this is a conversation, not a printed notice.
    expect(req.canUseTool).toBeDefined()
    expect(req.nextUserInput).toBeDefined()
    expect(req.onText).toBeDefined()
    // The shipped path keeps the SDK's per-action confirm (spec 03-03 §5.4).
    expect(req.permissionMode).toBeUndefined()
    expect(infos.join('\n')).toContain('yt-dlp')
  })

  it('covers bun and the voice endpoint in the SAME conversation as music', async () => {
    const { host } = fakeHost(['y'])
    const { guide, requests } = fakeGuide()
    await runSetup({
      host,
      guide,
      targets: targets(),
      ledger: fakeLedger(),
      probes: { music: async () => NO_YTDLP, bun: async () => NO_BUN },
    })
    expect(requests).toHaveLength(1)
    const prompt = requests[0]!.prompt
    expect(prompt).toContain('yt-dlp')
    expect(prompt).toContain('bun')
    expect(prompt.toLowerCase()).toContain('voice')
  })

  it('prefers Homebrew for yt-dlp, with uv/pipx only as the fallback', async () => {
    const { host } = fakeHost(['y'])
    const { guide, requests } = fakeGuide()
    await runSetup({ host, guide, targets: targets({ wantsBun: false }), ledger: fakeLedger(), probes })
    const prompt = requests[0]!.prompt
    expect(prompt).toContain('brew')
    const brewAt = prompt.indexOf('brew')
    const uvAt = prompt.search(/\buv\b|pipx/)
    expect(uvAt).toBeGreaterThan(brewAt)
  })

  it('hands the voice gap the write_voice_config tool, and only then', async () => {
    const { host } = fakeHost(['y'])
    const { guide, requests } = fakeGuide()
    await runSetup({
      host,
      guide,
      targets: targets({ wantsMusic: false, wantsBun: false }),
      ledger: fakeLedger(),
      probes,
    })
    expect(requests[0]!.tools?.map((t) => t.name)).toEqual(['write_voice_config'])

    const music = fakeGuide()
    const { host: host2 } = fakeHost(['y'])
    await runSetup({
      host: host2,
      guide: music.guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      ledger: fakeLedger(),
      probes,
    })
    expect(music.requests[0]!.tools ?? []).toEqual([])
  })

  // Peer review (codex): the outcome drove `--setup`'s exit report, and bun was
  // missing from it — so a run whose ONLY unresolved gap was bun announced
  // "setup is complete". Every gap the offer covers is reported back.
  it('reports every covered gap, bun included', async () => {
    const { host } = fakeHost(['y'])
    const { guide } = fakeGuide()
    const outcome = await runSetup({
      host,
      guide,
      targets: targets({ voiceUrl: () => 'https://tts.example' }),
      ledger: fakeLedger(),
      probes: { music: async () => OK, bun: async () => NO_BUN },
    })
    expect(outcome).toEqual({ musicOk: true, bunOk: false, voiceOk: true })
  })

  it('a gap the session does not want is not reported as ok', async () => {
    const { host } = fakeHost()
    const { guide } = fakeGuide()
    const outcome = await runSetup({
      host,
      guide,
      targets: targets({ wantsMusic: false, wantsBun: false, wantsVoice: false }),
      ledger: fakeLedger(),
      probes: { music: async () => OK, bun: async () => OK },
    })
    expect(outcome).toEqual({ musicOk: false, bunOk: false, voiceOk: false })
  })

  it('no gaps = no offer, no conversation, not a word', async () => {
    const { host, infos } = fakeHost()
    const { guide, requests } = fakeGuide()
    const outcome = await runSetup({
      host,
      guide,
      targets: targets({ voiceUrl: () => 'https://tts.example' }),
      ledger: fakeLedger(),
      probes: { music: async () => OK, bun: async () => OK },
    })
    expect(requests).toEqual([])
    expect(infos).toEqual([])
    expect(outcome).toEqual({ musicOk: true, bunOk: true, voiceOk: true })
  })

  it('streams the guide text to the host as it arrives', async () => {
    const { host, infos } = fakeHost(['y'])
    const guide: GuideCapable = {
      runGuide: async (req) => {
        req.onText?.('looking around...')
        return 'done'
      },
    }
    await runSetup({ host, guide, targets: targets({ wantsBun: false }), ledger: fakeLedger(), probes })
    expect(infos.join('\n')).toContain('looking around...')
  })

  it('reports the outcome honestly when the repair did not stick', async () => {
    const { host, infos } = fakeHost(['y'])
    const { guide } = fakeGuide()
    const outcome = await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      ledger: fakeLedger(),
      probes,
    })
    expect(outcome.musicOk).toBe(false)
    expect(infos.join('\n')).toContain('still')
  })

  it('re-probes after the conversation, so a real fix is picked up this boot', async () => {
    const { host } = fakeHost(['y'])
    const { guide } = fakeGuide()
    const results = [NO_YTDLP, OK]
    const outcome = await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      ledger: fakeLedger(),
      probes: { music: async () => results.shift()!, bun: async () => OK },
    })
    expect(outcome.musicOk).toBe(true)
  })

  it('picks up an endpoint the guide wrote mid-conversation', async () => {
    const { host } = fakeHost(['y'])
    const { guide } = fakeGuide()
    let url = ''
    const outcome = await runSetup({
      host,
      guide: { runGuide: async (req) => ((url = 'https://written.example'), guide.runGuide(req)) },
      targets: targets({ wantsMusic: false, wantsBun: false, voiceUrl: () => url }),
      ledger: fakeLedger(),
      probes,
    })
    expect(outcome.voiceOk).toBe(true)
  })
})

describe('runSetup — declining, and what a decline costs later', () => {
  const probes = { music: async () => NO_YTDLP, bun: async () => OK }

  it('a decline writes the tier-3 setup.declined record and degrades the session', async () => {
    const { host, infos } = fakeHost(['n'])
    const { guide, requests } = fakeGuide()
    const ledger = fakeLedger()
    const outcome = await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      ledger,
      probes,
    })
    expect(requests).toEqual([])
    expect(outcome.musicOk).toBe(false)
    expect(ledger.events).toEqual([{ kind: 'setup', key: SETUP_DECLINED }])
    expect(infos.join('\n')).toContain('yt-dlp')
  })

  it('a closed stdin declines rather than wedging startup', async () => {
    // A piped or service run must still reach the air.
    const { host } = fakeHost([], { atEof: true })
    const { guide, requests } = fakeGuide()
    const ledger = fakeLedger()
    expect(
      (
        await runSetup({
          host,
          guide,
          targets: targets({ wantsBun: false, wantsVoice: false }),
          ledger,
          probes,
        })
      ).musicOk,
    ).toBe(false)
    expect(requests).toEqual([])
    expect(ledger.events).toHaveLength(1)
  })

  it('a later boot with the same gaps says ONE line and does not re-ask', async () => {
    const ledger = fakeLedger()
    ledger.recordEvent('setup', SETUP_DECLINED)
    ledger.events.length = 0

    // No scripted lines at all: if it asked anything, the read would hang.
    const { host, infos } = fakeHost()
    const { guide, requests } = fakeGuide()
    const outcome = await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      ledger,
      probes,
    })
    expect(requests).toEqual([])
    expect(outcome.musicOk).toBe(false)
    expect(infos).toHaveLength(1)
    expect(infos[0]).toContain('make setup')
    // The record is not re-written on every quiet boot.
    expect(ledger.events).toEqual([])
  })

  it('an explicit entry always converses, decline record or not', async () => {
    const ledger = fakeLedger()
    ledger.recordEvent('setup', SETUP_DECLINED)
    ledger.events.length = 0

    const { host } = fakeHost(['y'])
    const { guide, requests } = fakeGuide()
    await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      ledger,
      probes,
      explicit: true,
    })
    expect(requests).toHaveLength(1)
  })

  it('an explicit entry declined does NOT silence later boots', async () => {
    // `make setup` is the user reaching for it on purpose; backing out of one
    // is not the standing "stop asking me" the boot-time offer records.
    const { host } = fakeHost(['n'])
    const { guide } = fakeGuide()
    const ledger = fakeLedger()
    await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      ledger,
      probes,
      explicit: true,
    })
    expect(ledger.events).toEqual([])
  })

  it('runs without a ledger at all (a stub session keeps no record)', async () => {
    const { host } = fakeHost(['n'])
    const { guide } = fakeGuide()
    const outcome = await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      probes,
    })
    expect(outcome.musicOk).toBe(false)
  })
})
