import { describe, expect, it } from 'vitest'

import type { Host } from '../src/host.ts'
import { musicCheck, runStartupChecks, type StartupCheck } from '../src/startup.ts'

function fakeHost(): { host: Host; infos: string[] } {
  const infos: string[] = []
  const host: Host = {
    start: () => {},
    peekLine: () => new Promise(() => {}),
    takeLine: () => undefined,
    onRadioSegment: () => {},
    onUserLine: () => {},
    info: (m) => void infos.push(m),
  }
  return { host, infos }
}

describe('runStartupChecks', () => {
  it('runs registered checks in order and collects results by name', async () => {
    const ran: string[] = []
    const make = (name: string, ok: boolean): StartupCheck => ({
      name,
      run: async () => {
        ran.push(name)
        return ok
      },
    })
    const { host } = fakeHost()
    // a second registered check runs without any app-loop change (the seam is real)
    const results = await runStartupChecks([make('music', false), make('other', true)], host)
    expect(ran).toEqual(['music', 'other'])
    expect(results).toEqual({ music: false, other: true })
  })

  it('a throwing check degrades to false, not a crash', async () => {
    const boom: StartupCheck = {
      name: 'boom',
      run: async () => {
        throw new Error('nope')
      },
    }
    const { host } = fakeHost()
    expect(await runStartupChecks([boom], host)).toEqual({ boom: false })
  })
})

describe('musicCheck', () => {
  it('passes when both binaries answer', async () => {
    const check = musicCheck({ ytdlpCmd: 'yt-dlp', ffmpegCmd: 'ffmpeg', probe: async () => true })
    const { host, infos } = fakeHost()
    expect(await check.run(host)).toBe(true)
    expect(infos).toEqual([])
  })

  it('probes yt-dlp with a real trivial search requiring output, not just --version', async () => {
    // An installed-but-broken yt-dlp (rotted extractor, proxy failure) still
    // answers --version; the preflight must exercise a fetch (spec 03-03 §2).
    const probed: { cmd: string; args: string[]; requireStdout: boolean }[] = []
    const check = musicCheck({
      ytdlpCmd: 'yt-dlp',
      ffmpegCmd: 'ffmpeg',
      probe: async (cmd, args, requireStdout) => {
        probed.push({ cmd, args, requireStdout })
        return true
      },
    })
    const { host } = fakeHost()
    await check.run(host)
    const ytdlp = probed.find((p) => p.cmd === 'yt-dlp')!
    expect(ytdlp.args.join(' ')).toContain('ytsearch1:')
    expect(ytdlp.requireStdout).toBe(true)
  })

  it('fails plainly, naming the missing binary (session degrades to talk-only)', async () => {
    const check = musicCheck({
      ytdlpCmd: 'yt-dlp',
      ffmpegCmd: 'ffmpeg',
      probe: async (cmd) => cmd !== 'yt-dlp',
    })
    const { host, infos } = fakeHost()
    expect(await check.run(host)).toBe(false)
    expect(infos.join('\n')).toContain('yt-dlp')
  })
})
