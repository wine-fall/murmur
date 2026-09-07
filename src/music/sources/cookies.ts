// The one cookie reader (spec 14 §2.8): yt-dlp already knows how to open
// every browser's cookie store (and how to unlock it on macOS), so the small
// identity clients never grow a second reader. yt-dlp is asked to export the
// store to a Netscape jar in a temp file — a bogus URL under --simulate, so
// nothing is fetched and the jar is still written on exit — the jar is read
// once, and deleted. It never persists, and no cookie is ever stored by
// murmur (§2.1: the browser NAME is what sources.json holds).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { YtDlpRunner } from '../music.ts'
import { browserArgs, type BrowserName } from './store.ts'

export type CookieRow = { domain: string; name: string; value: string }

// Netscape format: domain, flag, path, secure, expiry, name, value — tab
// separated; a leading #HttpOnly_ marks a row rather than commenting it out.
export function parseNetscapeJar(text: string): CookieRow[] {
  const rows: CookieRow[] = []
  for (const raw of text.split('\n')) {
    const line = raw.startsWith('#HttpOnly_') ? raw.slice('#HttpOnly_'.length) : raw
    if (line === '' || line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    rows.push({ domain: parts[0]!, name: parts[5]!, value: parts[6]! })
  }
  return rows
}

// The Cookie header for one site: rows whose domain is the site or a parent
// of it (`.music.163.com` serves music.163.com), in jar order.
export function cookieHeader(rows: readonly CookieRow[], site: string): string {
  return rows
    .filter((row) => {
      const domain = row.domain.replace(/^\./, '')
      return site === domain || site.endsWith(`.${domain}`)
    })
    .map((row) => `${row.name}=${row.value}`)
    .join('; ')
}

// A URL yt-dlp will not fetch under --simulate with no extractor claiming it;
// the run exists only for its exit, where the jar is written.
const NO_URL = 'https://127.0.0.1:1/murmur-cookie-export'

export async function exportCookieJar(
  entry: { browser: BrowserName; profile?: string | undefined },
  run: YtDlpRunner,
): Promise<CookieRow[]> {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-jar-'))
  const path = join(dir, 'cookies.txt')
  try {
    // The extraction of the bogus URL fails; that is expected and ignored —
    // the jar is written by yt-dlp's exit regardless.
    await run([...browserArgs(entry), '--cookies', path, '--simulate', '--no-warnings', '--ignore-errors', NO_URL]).catch(() => '')
    let text: string
    try {
      text = readFileSync(path, 'utf-8')
    } catch {
      return []
    }
    return parseNetscapeJar(text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
