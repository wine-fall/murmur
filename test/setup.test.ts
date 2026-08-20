import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { GuideCapable, GuideRequest, LedgerKind } from '../src/contracts.ts'
import {
  detectGaps,
  quitLatch,
  runSetup,
  SETUP_DECLINED,
  setupOfferText,
  type SetupLedger,
  type SetupTargets,
  validateEndpoint,
} from '../src/guide.ts'
import type { AskKind, Host } from '../src/host.ts'
import { InProcessMemoryStore } from '../src/memory.ts'
import type { PreflightResult } from '../src/startup.ts'
import { readVoiceConfig, type VoiceConfig, VOICE_PROBE_LINE } from '../src/voice-config.ts'
import { encodeWav } from '../src/wav.ts'

const OK: PreflightResult = { ok: true, reason: '' }
const NO_YTDLP: PreflightResult = { ok: false, reason: "yt-dlp binary not found: 'yt-dlp'" }
const NO_BUN: PreflightResult = { ok: false, reason: "bun binary not found: 'bun'" }
const STALE_YTDLP: PreflightResult = {
  ok: false,
  reason: 'yt-dlp 2026.03.01 is 164 days old — an upgrade is recommended',
}

function fakeHost(
  lines: string[] = [],
  { atEof = false, docked = false } = {},
): {
  host: Host
  infos: string[]
  flows: string[]
  asks: { text: string; kind: AskKind }[]
  interrupts: { handler: (() => void) | null }
  modes: string[]
} {
  const infos: string[] = []
  const flows: string[] = []
  const asks: { text: string; kind: AskKind }[] = []
  const interrupts: { handler: (() => void) | null } = { handler: null }
  const modes: string[] = []
  const host: Host = {
    start: () => {},
    peekLine: () => (lines.length > 0 ? Promise.resolve(lines[0]!) : new Promise(() => {})),
    takeLine: () => lines.shift(),
    eof: () => (atEof ? Promise.resolve() : new Promise(() => {})),
    onRadioSegment: () => {},
    onUserLine: () => {},
    info: (m, tone) => {
      infos.push(m)
      if (tone === 'flow') flows.push(m)
    },
    onInterrupt: (handler) => void (interrupts.handler = handler),
    setMode: (who) => void modes.push(who),
    banner: () => {},
  }
  if (docked) host.ask = (text, kind) => void asks.push({ text, kind })
  return { host, infos, flows, asks, interrupts, modes }
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
  voiceConfig: () => null,
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
      ytdlpFresh: async () => OK,
    })
    expect(gaps).toEqual([])
  })

  // issue #93: env / file / neither — the three ways an endpoint can be
  // present or absent. `voiceUrl` is the one seam that collapses them, so the
  // gap must follow it and nothing else.
  it('names the voice gap only when neither layer supplies an endpoint', async () => {
    const probes = { music: async () => OK, bun: async () => OK, ytdlpFresh: async () => OK }
    const voiceGaps = async (url: string): Promise<string[]> =>
      (await detectGaps(targets({ voiceUrl: () => url }), probes)).map((g) => g.kind)

    expect(await voiceGaps('https://env.example')).toEqual([]) // env supplied it
    expect(await voiceGaps('https://file.example')).toEqual([]) // voice.json did
    expect(await voiceGaps('')).toEqual(['voice']) // neither
    // Whitespace is not an endpoint.
    expect(await voiceGaps('   ')).toEqual(['voice'])
  })

  it('never blocks: the voice gap is one item among the others, not a stopper', async () => {
    const gaps = await detectGaps(targets(), {
      music: async () => NO_YTDLP,
      bun: async () => NO_BUN,
    })
    expect(gaps.map((g) => g.kind)).toEqual(['music', 'bun', 'voice'])
  })
})

// A yt-dlp alive today still rots: the sites it fetches from move their APIs
// and anti-bot checks (Bilibili breaks first), and releases are dated. An old
// release is its OWN gap: the repair is an upgrade conversation, and music
// keeps working rather than degrading to talk-only.
describe('detectGaps — the yt-dlp freshness probe', () => {
  it('working music + a stale release = a ytdlp gap, not a music gap', async () => {
    const gaps = await detectGaps(targets({ wantsBun: false, wantsVoice: false }), {
      music: async () => OK,
      bun: async () => OK,
      ytdlpFresh: async () => STALE_YTDLP,
    })
    expect(gaps).toEqual([{ kind: 'ytdlp', reason: STALE_YTDLP.reason }])
  })

  it('broken music swallows the freshness finding: that repair is an install, so age is not probed', async () => {
    let probed = 0
    const gaps = await detectGaps(targets({ wantsBun: false, wantsVoice: false }), {
      music: async () => NO_YTDLP,
      ytdlpFresh: async () => {
        probed++
        return STALE_YTDLP
      },
    })
    expect(gaps.map((g) => g.kind)).toEqual(['music'])
    expect(probed).toBe(0)
  })

  it('a session without music never probes freshness', async () => {
    let probed = 0
    const gaps = await detectGaps(
      targets({ wantsMusic: false, wantsBun: false, wantsVoice: false }),
      {
        ytdlpFresh: async () => {
          probed++
          return OK
        },
      },
    )
    expect(gaps).toEqual([])
    expect(probed).toBe(0)
  })

  it('staleness never degrades the session, but the outcome reports it honestly', async () => {
    // musicOk stays true (the radio keeps playing) — while ytdlpFresh says the
    // one thing this entry did not fix, so `--setup` cannot claim completion
    // over a gap it just re-detected (codex review).
    const { host } = fakeHost(['n'])
    const { guide } = fakeGuide()
    const outcome = await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      ledger: fakeLedger(),
      probes: { music: async () => OK, bun: async () => OK, ytdlpFresh: async () => STALE_YTDLP },
    })
    expect(outcome.musicOk).toBe(true)
    expect(outcome.ytdlpFresh).toBe(false)
  })

  it('the card shows music as ready and names the ytdlp gap with its consequence', () => {
    const text = setupOfferText(targets({ wantsBun: false, wantsVoice: false }), [
      { kind: 'ytdlp', reason: STALE_YTDLP.reason },
    ])
    expect(text).toContain('ok music')
    expect(text).toContain('-- ytdlp')
    expect(text.toLowerCase()).toContain('upgrade')
    // The card stays ASCII-safe (same bar as the other rows).
    expect(text).toMatch(/^[\x20-\x7e\n]*$/)
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
    // The shipped path still routes through canUseTool (the quit deny and the
    // secret belt live there — spec 03-03 §3).
    expect(req.permissionMode).toBeUndefined()
    expect(infos.join('\n')).toContain('yt-dlp')
  })

  it('shows tool activity through the host — commands before, output after', async () => {
    // A consented install must never run in silence: the host hears the
    // command as it starts and the tail of its output when it lands.
    const { host, infos } = fakeHost(['y'])
    const guide: GuideCapable = {
      runGuide: async (req) => {
        req.onToolUse?.('Bash', 'brew upgrade yt-dlp', 't1')
        req.onToolResult?.('Upgrading yt-dlp\nDone.', false, 't1')
        req.onToolResult?.('no such formula', true, 't2')
        return 'explained.'
      },
    }
    await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false }),
      ledger: fakeLedger(),
      probes,
    })
    const shown = infos.join('\n')
    expect(shown).toContain('-> [Bash] brew upgrade yt-dlp')
    expect(shown).toContain('  Upgrading yt-dlp\n  Done.')
    expect(shown).toContain('  [error]\n  no such formula')
  })

  it('withholds the output of a secret-bearing tool use — info mirrors into the dev log', async () => {
    // The SECRET_BEARING guard on auto-allow does not cover a MANUALLY
    // approved read of voice.json/.env; its result must not be echoed either.
    const { host, infos } = fakeHost(['y'])
    const guide: GuideCapable = {
      runGuide: async (req) => {
        req.onToolUse?.('Read', '{"file_path":"/home/u/.murmur/voice.json"}', 's1')
        req.onToolResult?.('{"apiKey":"sk-super-secret"}', false, 's1')
        req.onToolUse?.('Bash', 'cat .env', 's2')
        req.onToolResult?.('MURMUR_TTS_API_KEY=sk-more-secret', false, 's2')
        return 'explained.'
      },
    }
    await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false }),
      ledger: fakeLedger(),
      probes,
    })
    const shown = infos.join('\n')
    expect(shown).not.toContain('sk-super-secret')
    expect(shown).not.toContain('sk-more-secret')
    expect(shown).toContain('(output withheld: may hold a credential)')
    // The command lines themselves stay visible — they carry no secret.
    expect(shown).toContain('-> [Bash] cat .env')
  })

  it('docks the WHOLE pre-broadcast checklist as one consent ask (spec 10 §3.2-B spotlight)', async () => {
    // Diagnosis and invitation share one card: ready rows, gap rows, then the
    // y/N — the modal renders it whole, the plain host prints the same text.
    const { host, infos, asks } = fakeHost(['y'], { docked: true })
    const { guide } = fakeGuide()
    await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false }),
      ledger: fakeLedger(),
      probes,
    })
    expect(asks).toHaveLength(1)
    expect(asks[0]!.kind).toBe('consent')
    expect(asks[0]!.text).toContain('>> y - fix them now')
    expect(asks[0]!.text).toContain('-- music')
    // The probe detail is diagnostics, not card copy — it goes to the dev log.
    expect(infos.join('\n')).not.toContain('>> y - fix them now')
  })

  describe('setupOfferText — the checklist card copy', () => {
    const gaps = [{ kind: 'voice', reason: 'no endpoint configured' } as const]

    it('leads with the summary, lists ready rows before gap rows, ends with the three options', () => {
      const lines = setupOfferText(targets(), gaps).split('\n')
      expect(lines[0]).toContain("aren't set up")
      const okAt = lines.findIndex((l) => l.startsWith('ok '))
      const gapAt = lines.findIndex((l) => l.startsWith('-- '))
      expect(okAt).toBeGreaterThan(0)
      expect(gapAt).toBeGreaterThan(okAt)
      // One option per line, each visibly an option (user report: the old
      // single-line action row did not read as choices, and Enter looked like
      // a default y).
      expect(lines.slice(-3).every((l) => l.startsWith('>> '))).toBe(true)
      expect(lines.at(-3)).toContain('y - fix them now')
      // The y is an authorization, and the card says so: murmur acts on it,
      // checking back only at real choices (spec 03-03 §3).
      expect(lines.at(-3)).toContain('real choices')
      expect(lines.at(-2)).toContain('Enter - not now')
      expect(lines.at(-1)).toContain("n - don't ask again")
    })

    it('an explicit entry offers only the answers it honors — no boot-persistence promises', () => {
      // `make setup` neither consults nor writes the standing decline (codex
      // review): its card must not say "next boot" or "don't ask again".
      const text = setupOfferText(targets(), gaps, true)
      const options = text.split('\n').filter((l) => l.startsWith('>> '))
      expect(options).toEqual([
        ">> y - fix them now (I'll run the fixes, and check with you at real choices)",
        '>> Enter - skip for now',
      ])
      expect(text).not.toContain('next boot')
      expect(text).not.toContain("don't ask again")
    })

    it('always credits the brain, and names each gap with its consequence', () => {
      const text = setupOfferText(targets(), gaps)
      expect(text).toContain('ok brain')
      expect(text).toContain('-- voice')
      expect(text).toContain('shown instead of spoken')
    })

    it('keeps the card ASCII-safe: no ambiguous-width symbols (probe finding)', () => {
      // East-Asian-Ambiguous glyphs shift borders on some terminals; the card
      // is immune only if its copy stays ASCII + CJK + box lines.
      expect(setupOfferText(targets(), gaps)).toMatch(/^[\x20-\x7e\n]*$/)
    })

    it('lists only what this session wants: no bun row either way when bun is unwanted', () => {
      const text = setupOfferText(targets({ wantsBun: false }), gaps)
      expect(text).not.toContain('bun')
    })
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
      probes: { music: async () => OK, bun: async () => NO_BUN, ytdlpFresh: async () => OK },
    })
    expect(outcome).toEqual({ musicOk: true, ytdlpFresh: true, bunOk: false, voiceOk: true })
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
    expect(outcome).toEqual({ musicOk: false, ytdlpFresh: false, bunOk: false, voiceOk: false })
  })

  it('no gaps = no offer, no conversation — only the checking notice', async () => {
    // The probes take real seconds (yt-dlp is a network search): the one line
    // before them is the loading signal the front-end shows while they run.
    const { host, infos } = fakeHost()
    const { guide, requests } = fakeGuide()
    const outcome = await runSetup({
      host,
      guide,
      targets: targets({ voiceUrl: () => 'https://tts.example' }),
      ledger: fakeLedger(),
      probes: { music: async () => OK, bun: async () => OK, ytdlpFresh: async () => OK },
    })
    expect(requests).toEqual([])
    expect(infos).toHaveLength(1)
    expect(infos[0]).toContain('checking')
    expect(outcome).toEqual({ musicOk: true, ytdlpFresh: true, bunOk: true, voiceOk: true })
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
      probes: { music: async () => results.shift()!, bun: async () => OK, ytdlpFresh: async () => OK },
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

// Issue #96: hosted fish.audio rejects a request that carries only a URL — the
// key and the `model` header are required, and reference_id is what keeps the
// timbre from drifting. The probe synth must therefore speak with the WHOLE
// config, or the one backend new users are pointed at can never validate.
describe('validateEndpoint (spec 03-03 §7.2 — the proof-of-life synth)', () => {
  // What a healthy TTS server hands back: the probe measures the clip, so the
  // fake has to be a real wav rather than an arbitrary blob.
  const oneWav = (): ArrayBuffer => {
    const wav = encodeWav({ channels: 1, sampleRate: 16_000, bitsPerSample: 16 }, Buffer.alloc(320))
    const body = new ArrayBuffer(wav.byteLength)
    new Uint8Array(body).set(wav)
    return body
  }

  it('sends every hosted knob the endpoint needs', async () => {
    const seen: { headers: Headers; body: string }[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      seen.push({
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : '',
      })
      return new Response(oneWav(), { status: 200 })
    }
    await validateEndpoint(
      {
        ttsUrl: 'https://api.fish.audio',
        model: 's2.1-pro-free',
        referenceId: 'abc123',
        apiKey: 'sk-not-a-real-key',
      },
      fetchImpl,
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer sk-not-a-real-key')
    expect(seen[0]!.headers.get('model')).toBe('s2.1-pro-free')
    expect(JSON.parse(seen[0]!.body)).toMatchObject({
      reference_id: 'abc123',
      text: VOICE_PROBE_LINE,
    })
  })

  it('a self-hosted URL still validates with nothing but the URL', async () => {
    const seen: Headers[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      seen.push(new Headers(init?.headers))
      return new Response(oneWav(), { status: 200 })
    }
    await validateEndpoint({ ttsUrl: 'https://self-hosted.example' }, fetchImpl)
    expect(seen[0]!.get('authorization')).toBeNull()
    expect(seen[0]!.get('model')).toBeNull()
  })
})

describe('runSetup — the voice endpoint conversation (issue #96)', () => {
  const probes = { music: async () => OK, bun: async () => OK }

  it('captures the API key at the keyboard, and never says it out loud', async () => {
    const secret = 'sk-not-a-real-key'
    // 'y' answers the offer; the key is the NEXT line the user types — read by
    // the tool itself, not by the conversation.
    const { host, infos } = fakeHost(['y', secret])
    const home = mkdtempSync(join(tmpdir(), 'murmur-setup-'))
    const written: VoiceConfig[] = []
    const guide: GuideCapable = {
      runGuide: async (req) => {
        const tool = req.tools?.[0]
        if (tool === undefined) throw new Error('the voice gap got no write tool')
        await tool.handler(
          { ttsUrl: 'https://api.fish.audio', model: 's2.1-pro-free', needsApiKey: true },
          {},
        )
        return 'done'
      },
    }
    await runSetup({
      host,
      guide,
      targets: targets({ wantsMusic: false, wantsBun: false, home }),
      probes,
      validateVoice: async (config) => void written.push(config),
    })
    expect(written[0]?.apiKey).toBe(secret)
    expect(readVoiceConfig(join(home, 'voice.json'))?.apiKey).toBe(secret)
    // Everything murmur printed — the ask included — carries no credential.
    expect(infos.join('\n')).not.toContain(secret)
  })

  it('docks the paste prompt as a question, still without the credential', async () => {
    const secret = 'sk-not-a-real-key'
    const { host, infos, asks } = fakeHost(['y', secret], { docked: true })
    const home = mkdtempSync(join(tmpdir(), 'murmur-setup-'))
    const guide: GuideCapable = {
      runGuide: async (req) => {
        await req.tools?.[0]?.handler(
          { ttsUrl: 'https://api.fish.audio', model: 's2.1-pro-free', needsApiKey: true },
          {},
        )
        return 'done'
      },
    }
    await runSetup({
      host,
      guide,
      targets: targets({ wantsMusic: false, wantsBun: false, home }),
      probes,
      validateVoice: async () => {},
    })
    const paste = asks.find((a) => a.text.includes('paste'))
    expect(paste?.kind).toBe('question')
    const everything = [...infos, ...asks.map((a) => a.text)].join('\n')
    expect(everything).not.toContain(secret)
  })
})

describe('runSetup — declining, and what a decline costs later', () => {
  const probes = { music: async () => NO_YTDLP, bun: async () => OK }

  it('/quit at the offer leaves NO standing decline — leaving is not answering (codex review)', async () => {
    const ledger = fakeLedger()
    const { host, infos } = fakeHost(['/quit'])
    const { guide } = fakeGuide()
    const quit = quitLatch()
    await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false }),
      ledger,
      probes,
      quit,
    })
    expect(quit.requested).toBe(true)
    expect(ledger.events).toEqual([])
    expect(infos.join('\n')).not.toContain("won't ask again")
  })

  it('/quit mid-conversation returns on the known gaps: no re-probe, no closing verdict', async () => {
    // The user is leaving; a second yt-dlp probe (a live network search) and a
    // "still not working" report would make the exit wait on work nobody will
    // see. The interrupt signal also reaches the guide so the SDK session is
    // cut instead of waited out.
    const { host, infos } = fakeHost(['y'])
    const quit = quitLatch()
    let musicProbes = 0
    const requests: GuideRequest[] = []
    const guide: GuideCapable = {
      runGuide: async (req) => {
        requests.push(req)
        quit.fire()
        return 'interrupted.'
      },
    }
    const outcome = await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      probes: {
        music: async () => {
          musicProbes++
          return NO_YTDLP
        },
      },
      quit,
    })
    await requests[0]!.interrupt // resolves because quit fired
    expect(musicProbes).toBe(1)
    expect(outcome.musicOk).toBe(false)
    expect(infos.join('\n')).not.toContain('all set')
    expect(infos.join('\n')).not.toContain('still not working')
  })

  it('Esc mid-turn cuts the TURN, not the session: the conversation continues (spec 03-03 §7 lifecycle)', async () => {
    // The technician model: Esc while the guide works = query.interrupt() —
    // the turn dies, the session lives, the next typed line still goes to the
    // guide. Only /quit closes the session.
    const { host, infos, flows, interrupts } = fakeHost(['y', '/done'])
    let musicProbes = 0
    let turnCuts = 0
    const requests: GuideRequest[] = []
    const guide: GuideCapable = {
      runGuide: async (req) => {
        requests.push(req)
        req.onSession?.({ interruptTurn: async () => void turnCuts++ })
        interrupts.handler?.() // Esc lands while the turn is in flight
        // The session survives the Esc: the reply loop still runs and the
        // typed /done is what actually ends it.
        expect(await req.nextUserInput?.()).toBeNull()
        return 'done'
      },
    }
    const outcome = await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      probes: {
        music: async () => {
          musicProbes++
          return NO_YTDLP
        },
      },
    })
    expect(turnCuts).toBe(1)
    expect(outcome.musicOk).toBe(false)
    // The stop is a state transition the listener must SEE: marked ink.
    expect(flows.some((m) => m.includes('stopped'))).toBe(true)
    // A normal end: the closing re-probe runs and reports.
    expect(musicProbes).toBe(2)
    expect(infos.join('\n')).toContain('still not working')
    // The flow is over: the handler is unregistered so a later Esc is noise.
    expect(interrupts.handler).toBeNull()
  })

  it('Esc while the guide waits for a reply ends the conversation — the Esc-Esc exit ≡ /done', async () => {
    const { host, infos, interrupts } = fakeHost(['y'])
    let musicProbes = 0
    const guide: GuideCapable = {
      runGuide: async (req) => {
        const pending = req.nextUserInput?.()
        await new Promise((r) => setImmediate(r))
        interrupts.handler?.() // the guide is idle at the reply prompt
        expect(await pending).toBeNull()
        return 'done'
      },
    }
    await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      probes: {
        music: async () => {
          musicProbes++
          return NO_YTDLP
        },
      },
    })
    // Ending is ending: same closing re-probe and verdict as a typed /done.
    expect(musicProbes).toBe(2)
    expect(infos.join('\n')).toContain('still not working')
  })

  it('Esc at the offer reads as "not now" — never a standing decline', async () => {
    const ledger = fakeLedger()
    const { host, infos, interrupts } = fakeHost([])
    const { guide, requests } = fakeGuide()
    const pending = runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      ledger,
      probes,
    })
    await new Promise((r) => setImmediate(r))
    interrupts.handler?.()
    await pending
    expect(requests).toEqual([])
    expect(ledger.events).toEqual([])
    expect(infos.join('\n')).not.toContain("won't ask again")
    expect(infos.join('\n')).toContain('not now')
  })

  it('Esc during the opening probes is already armed: no offer opens', async () => {
    // detectGaps is a live network search taking real seconds; the Esc seam
    // must exist for its whole window, not only once the offer is up.
    const { host, asks, infos, interrupts } = fakeHost([], { docked: true })
    const { guide, requests } = fakeGuide()
    await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      ledger: fakeLedger(),
      probes: {
        music: async () => {
          interrupts.handler?.() // Esc lands mid-probe
          return NO_YTDLP
        },
      },
    })
    expect(asks).toEqual([])
    expect(requests).toEqual([])
    expect(infos.join('\n')).toContain('not now')
  })

  it('Esc while the paste prompt waits aborts the TOOL; a second Esc at the idle prompt hands back', async () => {
    const { host, interrupts } = fakeHost(['y'])
    const home = mkdtempSync(join(tmpdir(), 'murmur-setup-'))
    let validated = 0
    const guide: GuideCapable = {
      runGuide: async (req) => {
        const tool = req.tools?.[0]
        if (tool === undefined) throw new Error('the voice gap got no write tool')
        const pending = tool.handler(
          { ttsUrl: 'https://api.fish.audio', model: 's2.1-pro-free', needsApiKey: true },
          {},
        )
        // The paste prompt is waiting on the keyboard; Esc #1 lands mid-turn:
        // the tool aborts, the session lives.
        await new Promise((r) => setImmediate(r))
        interrupts.handler?.()
        await pending
        // The guide goes idle at the reply prompt; Esc #2 is the hand-back.
        const reply = req.nextUserInput?.()
        await new Promise((r) => setImmediate(r))
        interrupts.handler?.()
        expect(await reply).toBeNull()
        return 'done'
      },
    }
    await runSetup({
      host,
      guide,
      targets: targets({ wantsMusic: false, wantsBun: false, home }),
      probes: { music: async () => OK, bun: async () => OK },
      validateVoice: async () => void validated++,
    })
    expect(validated).toBe(0)
    expect(readVoiceConfig(join(home, 'voice.json'))).toBeNull()
  })

  it('a guide session that dies must not take the radio down — the boot continues (real-SDK crash shape)', async () => {
    // Reproduced live: ending the streaming input right after an interrupted
    // turn makes the SDK iterator throw its error result. Whatever the guide
    // dies of, runSetup absorbs it: one honest line, floor back, outcome from
    // the known gaps — the radio always launches (spec 03-03).
    const { host, infos, modes } = fakeHost(['y'])
    const guide: GuideCapable = {
      runGuide: async () => {
        throw new Error('Claude Code returned an error result: [ede_diagnostic] stop_reason=tool_use')
      },
    }
    const outcome = await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      probes,
    })
    expect(outcome.musicOk).toBe(false)
    expect(modes).toEqual(['guide', 'radio'])
    expect(infos.join('\n')).toContain('ended unexpectedly')
  })

  it('the guide holds the floor from the y to the conversation end — BEFORE the closing probe', async () => {
    // The re-probe takes seconds; a face still saying "talking to the setup
    // guide" while lines queue for the Director would recreate the exact
    // wrong-partner confusion this boundary exists to kill.
    const events: string[] = []
    const { host, modes } = fakeHost(['y', '/done'])
    const inner = host.setMode!
    host.setMode = (who) => {
      events.push(`mode:${who}`)
      inner(who)
    }
    const { guide } = fakeGuide()
    await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      probes: {
        music: async () => {
          events.push('probe')
          return NO_YTDLP
        },
      },
    })
    expect(modes).toEqual(['guide', 'radio'])
    // The floor went back BETWEEN the conversation and the closing probe.
    expect(events).toEqual(['probe', 'mode:guide', 'mode:radio', 'probe'])
  })

  it('Esc during the validating synth still aborts, even after a new turn reset the flow flag', async () => {
    // The race codex found: interruptTurn ends the turn, nextUserInput opens a
    // new one (resetting turnAborted) while the tool's validate is still in
    // flight — the abort must be scoped to the tool call, not the flow flag.
    const { host, interrupts } = fakeHost(['y'])
    const home = mkdtempSync(join(tmpdir(), 'murmur-setup-'))
    let releaseValidate!: () => void
    const validateGate = new Promise<void>((r) => (releaseValidate = r))
    const guide: GuideCapable = {
      runGuide: async (req) => {
        const tool = req.tools?.[0]
        if (tool === undefined) throw new Error('the voice gap got no write tool')
        const pending = tool.handler({ ttsUrl: 'https://api.fish.audio', model: 's2.1-pro-free' }, {})
        await new Promise((r) => setImmediate(r))
        interrupts.handler?.() // Esc lands while validate is in flight
        // The SDK ends the turn and the reply loop opens a NEW turn, which
        // resets the flow-level abort flag — the classic race window.
        const reply = req.nextUserInput?.()
        await new Promise((r) => setImmediate(r))
        releaseValidate() // validate finishes only now
        await pending
        await new Promise((r) => setImmediate(r))
        interrupts.handler?.() // idle Esc: hand back
        expect(await reply).toBeNull()
        return 'done'
      },
    }
    await runSetup({
      host,
      guide,
      targets: targets({ wantsMusic: false, wantsBun: false, home }),
      probes: { music: async () => OK, bun: async () => OK },
      validateVoice: async () => validateGate,
    })
    expect(readVoiceConfig(join(home, 'voice.json'))).toBeNull()
  })

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

  it('a closed stdin skips without wedging startup — and without a standing decline', async () => {
    // A piped or service run must still reach the air; nobody answering is
    // not the same fact as "stop asking me".
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
    expect(ledger.events).toEqual([])
  })

  it('Enter skips ONCE — no standing decline, the next boot offers again (user report)', async () => {
    // Enter reads as the default-confirm to half the world: it must never be
    // the key that silences the offer forever.
    const ledger = fakeLedger()
    const { host, infos } = fakeHost([''])
    const { guide, requests } = fakeGuide()
    await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      ledger,
      probes,
    })
    expect(requests).toEqual([])
    expect(ledger.events).toEqual([])
    expect(infos.join('\n')).toContain('next boot')
    expect(infos.join('\n')).not.toContain("won't ask again")
  })

  it('a Chinese yes opens the conversation; a Chinese no is the standing decline', async () => {
    {
      const { host } = fakeHost(['\u597d\u7684']) // "hao de" - sure
      const { guide, requests } = fakeGuide()
      await runSetup({
        host,
        guide,
        targets: targets({ wantsBun: false, wantsVoice: false }),
        ledger: fakeLedger(),
        probes,
      })
      expect(requests).toHaveLength(1)
    }
    {
      const ledger = fakeLedger()
      const { host } = fakeHost(['\u4e0d\u7528']) // "bu yong" - no need
      const { guide, requests } = fakeGuide()
      await runSetup({
        host,
        guide,
        targets: targets({ wantsBun: false, wantsVoice: false }),
        ledger,
        probes,
      })
      expect(requests).toEqual([])
      expect(ledger.events).toEqual([{ kind: 'setup', key: SETUP_DECLINED }])
    }
  })

  it('an unrecognized answer never becomes "stop asking": skip once, record clean', async () => {
    const ledger = fakeLedger()
    const { host, infos } = fakeHost(['maybe later?'])
    const { guide, requests } = fakeGuide()
    await runSetup({
      host,
      guide,
      targets: targets({ wantsBun: false, wantsVoice: false }),
      ledger,
      probes,
    })
    expect(requests).toEqual([])
    expect(ledger.events).toEqual([])
    expect(infos.join('\n')).toContain('make setup')
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
    // The checking notice (the probes still run), then exactly one pointer.
    expect(infos).toHaveLength(2)
    expect(infos[0]).toContain('checking')
    expect(infos[1]).toContain('make setup')
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
