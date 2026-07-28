import { describe, expect, it } from 'vitest'

import type { GuideCapable, GuideRequest } from '../src/contracts.ts'
import { cliConversation, cliPermission, musicSetupCheck, runMusicSetup } from '../src/guide.ts'
import type { Host } from '../src/host.ts'
import type { PreflightResult } from '../src/startup.ts'

// A host with scripted keyboard lines (the same stdin the Director uses).
function fakeHost(lines: string[] = []): { host: Host; infos: string[] } {
  const infos: string[] = []
  const host: Host = {
    start: () => {},
    peekLine: () => (lines.length > 0 ? Promise.resolve(lines[0]!) : new Promise(() => {})),
    takeLine: () => lines.shift(),
    onRadioSegment: () => {},
    onUserLine: () => {},
    info: (m) => void infos.push(m),
  }
  return { host, infos }
}

function fakeGuide(): { guide: GuideCapable; requests: GuideRequest[] } {
  const requests: GuideRequest[] = []
  const guide: GuideCapable = {
    runGuide: async (req) => {
      requests.push(req)
      return 'explained.'
    },
  }
  return { guide, requests }
}

const askOptions = { signal: new AbortController().signal }

describe('cliPermission (spec 03-03 §2 — route the ask, never own the semantics)', () => {
  it('prints the tool and its command, y allows', async () => {
    const { host, infos } = fakeHost(['y'])
    const result = await cliPermission(host)('Bash', { command: 'brew install yt-dlp' }, askOptions)
    expect(result).toEqual({ behavior: 'allow' })
    expect(infos.join('\n')).toContain('Bash')
    expect(infos.join('\n')).toContain('brew install yt-dlp')
  })

  it('anything but yes denies (the default is NO)', async () => {
    const { host } = fakeHost([''])
    const result = await cliPermission(host)('Write', { file_path: '/etc/hosts' }, askOptions)
    expect(result).toMatchObject({ behavior: 'deny' })
  })
})

describe('cliConversation', () => {
  it('returns the typed reply; empty or /done or q ends it', async () => {
    const { host } = fakeHost(['  the quick fix please  ', '', '/done', 'Q'])
    const next = cliConversation(host)
    expect(await next()).toBe('the quick fix please')
    expect(await next()).toBeNull()
    expect(await next()).toBeNull()
    expect(await next()).toBeNull()
  })
})

describe('runMusicSetup (spec 03-03 §3 flow)', () => {
  const broken: PreflightResult = { ok: false, reason: 'yt-dlp: binary not found' }
  const healthy: PreflightResult = { ok: true, reason: '' }

  it('a passing preflight engages nothing', async () => {
    const { host, infos } = fakeHost()
    const { guide, requests } = fakeGuide()
    const ok = await runMusicSetup(host, guide, { preflight: async () => healthy })
    expect(ok).toBe(true)
    expect(requests).toEqual([])
    expect(infos).toEqual([])
  })

  it('a failed preflight tells the user plainly and a decline skips the guide', async () => {
    const { host, infos } = fakeHost(['n'])
    const { guide, requests } = fakeGuide()
    const ok = await runMusicSetup(host, guide, { preflight: async () => broken })
    expect(ok).toBe(false)
    expect(requests).toEqual([])
    expect(infos.join('\n')).toContain('yt-dlp: binary not found')
    expect(infos.join('\n')).toContain('skipped')
  })

  it('on opt-in the guide runs with the finding as evidence, wired to the host, then rechecks', async () => {
    const { host } = fakeHost(['y'])
    const { guide, requests } = fakeGuide()
    const results = [broken, healthy]
    const ok = await runMusicSetup(host, guide, {
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      preflight: async () => results.shift()!,
    })
    expect(ok).toBe(true)
    const req = requests[0]!
    expect(req.prompt).toContain('yt-dlp: binary not found')
    expect(req.systemPrompt).toContain('setup assistant')
    expect(req.canUseTool).toBeDefined()
    expect(req.nextUserInput).toBeDefined()
    expect(req.onText).toBeDefined()
    // Shipped path: per-action confirm stays the SDK default (spec 03-03 §5.4).
    expect(req.permissionMode).toBeUndefined()
  })

  it('a repair that did not stick reports honestly', async () => {
    const { host, infos } = fakeHost(['y'])
    const { guide } = fakeGuide()
    const ok = await runMusicSetup(host, guide, { preflight: async () => broken })
    expect(ok).toBe(false)
    expect(infos.join('\n')).toContain("still isn't working")
  })

  it('streams the guide text to the host as info lines', async () => {
    const { host, infos } = fakeHost(['y'])
    const guide: GuideCapable = {
      runGuide: async (req) => {
        req.onText?.('looking around...')
        return 'done'
      },
    }
    await runMusicSetup(host, guide, { preflight: async () => broken })
    expect(infos.join('\n')).toContain('looking around...')
  })
})

describe('musicSetupCheck (spec 03-02 §2.4 — the auto-trigger at startup)', () => {
  it('is the music startup check, delegating to runMusicSetup', async () => {
    const { host } = fakeHost()
    const { guide } = fakeGuide()
    const check = musicSetupCheck(guide, { preflight: async () => ({ ok: true, reason: '' }) })
    expect(check.name).toBe('music')
    expect(await check.run(host)).toBe(true)
  })
})
