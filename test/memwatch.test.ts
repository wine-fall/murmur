import { describe, expect, it } from 'vitest'

import {
  applyFootprints,
  findRoots,
  formatTick,
  label,
  memTokenKb,
  parseMeminfoAvailableMb,
  parsePs,
  parseTopMem,
  parseVmStatAvailableMb,
  subtree,
  type Proc,
} from '../scripts/memwatch.ts'

const proc = (pid: number, ppid: number, rssKb: number, command: string): Proc => ({
  pid,
  ppid,
  rssKb,
  command,
})

describe('parsePs', () => {
  it('reads pid, ppid, rss and the whole command tail', () => {
    const text = ['  100     1   20480 murmur', ' 101   100   8192 /opt/homebrew/bin/ffmpeg -i http://x'].join('\n')
    expect(parsePs(text)).toEqual([
      proc(100, 1, 20480, 'murmur'),
      proc(101, 100, 8192, '/opt/homebrew/bin/ffmpeg -i http://x'),
    ])
  })

  it('skips header noise and short or non-numeric rows', () => {
    expect(parsePs('PID PPID RSS COMMAND\n\n  1 2\n')).toEqual([])
  })
})

describe('top MEM parsing', () => {
  it('converts each unit suffix to KB', () => {
    expect(memTokenKb('8722K')).toBe(8722)
    expect(memTokenKb('227M')).toBe(227 * 1024)
    expect(memTokenKb('1G')).toBe(1024 * 1024)
    expect(memTokenKb('2048')).toBe(2) // a bare number is bytes
  })

  it('tolerates the trailing markers top uses for a changed value', () => {
    expect(memTokenKb('5M+')).toBe(5 * 1024)
    expect(memTokenKb('5M-')).toBe(5 * 1024)
  })

  it('returns null for anything that is not a size', () => {
    expect(memTokenKb('')).toBeNull()
    expect(memTokenKb('nope')).toBeNull()
  })

  it('keeps only pid/size rows, skipping the preamble', () => {
    const text = ['Processes: 500 total', 'PID    MEM', '100    227M', '101    8722K', 'Load Avg: 1.0'].join('\n')
    expect(parseTopMem(text)).toEqual(new Map([[100, 227 * 1024], [101, 8722]]))
  })

  it('replaces ps RSS with the footprint where known, keeping RSS otherwise', () => {
    const procs = [proc(100, 1, 100, 'murmur'), proc(101, 100, 200, 'ffmpeg')]
    expect(applyFootprints(procs, new Map([[100, 999]]))).toEqual([
      proc(100, 1, 999, 'murmur'),
      proc(101, 100, 200, 'ffmpeg'),
    ])
    expect(applyFootprints(procs, new Map())).toEqual(procs)
  })
})

describe('finding the murmur tree', () => {
  const procs = [
    proc(100, 1, 20480, 'murmur'),
    proc(101, 100, 8192, '/opt/homebrew/bin/ffmpeg -i http://x'),
    proc(102, 101, 64, '/usr/bin/helper'),
    proc(200, 1, 1024, '/usr/bin/vim murmur-notes.txt'),
    proc(300, 1, 512, '/bin/sh -c "make dev; murmur"'),
  ]

  it('roots on the process that IS murmur, not one that merely mentions it', () => {
    expect(findRoots(procs).map((p) => p.pid)).toEqual([100])
  })

  it('keeps only the top of the tree when a descendant matches too', () => {
    const nested = [...procs, proc(400, 100, 128, 'murmur')]
    expect(findRoots(nested).map((p) => p.pid)).toEqual([100])
  })

  it('collects the root and every descendant', () => {
    expect(
      subtree(procs, 100)
        .map((p) => p.pid)
        .sort(),
    ).toEqual([100, 101, 102])
  })

  it('labels ffmpeg children, the main process, and everything else', () => {
    expect(label(procs[1]!)).toBe('ffmpeg')
    expect(label(procs[0]!)).toBe('main')
    expect(label(procs[2]!)).toBe('child')
  })
})

describe('system memory', () => {
  it('reads MemAvailable from /proc/meminfo text', () => {
    const text = 'MemTotal:       16000000 kB\nMemAvailable:    8192000 kB\n'
    expect(parseMeminfoAvailableMb(text)).toBe(8000)
    expect(parseMeminfoAvailableMb('MemTotal: 1 kB\n')).toBeNull()
  })

  it('sums the reclaimable vm_stat buckets at the reported page size', () => {
    const text = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                    100.',
      'Pages inactive:                200.',
      'Pages speculative:              50.',
      'Pages purgeable:                50.',
      'Pages wired down:             9999.',
    ].join('\n')
    expect(parseVmStatAvailableMb(text)).toBe((400 * 16384) / 1024 / 1024)
  })
})

describe('formatTick', () => {
  it('reports total, peak and a per-process breakdown largest-first', () => {
    const members = [proc(101, 100, 8192, 'ffmpeg'), proc(100, 1, 20480, 'murmur')]
    const line = formatTick(members, 40960, [16000, 8000])
    expect(line).toMatch(/^\d\d:\d\d:\d\d {2}total 28\.0 MB {2}\(peak 40\.0 MB\)/)
    expect(line).toContain('[main 20.0, ffmpeg 8.0]')
    expect(line).toContain('sys used 8000 / 16000 MB (avail 8000)')
  })

  it('omits the system tail when the machine total is unreadable', () => {
    expect(formatTick([proc(100, 1, 1024, 'murmur')], 0, null)).not.toContain('sys used')
  })
})
