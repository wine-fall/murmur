// The one cookie reader (spec 14 §2.8): yt-dlp already knows how to open
// every browser's cookie store (and how to unlock it on macOS), so the small
// identity clients never grow a second reader. yt-dlp is asked to export the
// store to a Netscape jar in a temp file — a bogus URL under --simulate, so
// nothing is fetched and the jar is still written on exit — the jar is read
// once, and deleted. It never persists, and no cookie is ever stored by
// murmur (§2.1: the browser NAME is what sources.json holds).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { z } from 'zod'

import type { YtDlpRunner } from '../music.ts'
import { browserArgs, type BrowserName } from './store.ts'

// Why a cookie store could not be read. yt-dlp says which in its stderr, and
// the three are answered with three different things: install it, grant the
// terminal access, install yt-dlp. An export that succeeds but holds no row
// for the site is NOT one of these — that is simply a missing login.
export type CookieFailure = 'no-browser' | 'no-permission' | 'no-ytdlp' | 'unreadable'

export class BrowserCookieError extends Error {
  readonly source: BrowserName
  readonly reason: CookieFailure
  readonly detail: string
  constructor(source: BrowserName, reason: CookieFailure, detail: string) {
    super(`${source}: ${reason}`)
    this.name = 'BrowserCookieError'
    this.source = source
    this.reason = reason
    this.detail = detail
  }
}

// execFile rejects with the child's own output attached; that text is the
// only evidence of which failure this was, so it is read at the boundary and
// narrowed here rather than discarded.
const SpawnFailure = z.object({ message: z.string().optional(), stderr: z.string().optional(), code: z.string().optional() })

export function classifyCookieFailure(err: unknown): { reason: CookieFailure; detail: string } {
  const parsed = SpawnFailure.safeParse(err)
  const fields = parsed.success ? parsed.data : {}
  const detail = (fields.stderr ?? '').trim() !== '' ? fields.stderr!.trim() : (fields.message ?? String(err)).trim()
  if (fields.code === 'ENOENT' || /\bENOENT\b/.test(detail)) return { reason: 'no-ytdlp', detail }
  if (/operation not permitted|permission denied/i.test(detail)) return { reason: 'no-permission', detail }
  // Only yt-dlp's own words for an absent store may claim the browser is not
  // installed. Everything else — a locked database, a DPAPI decrypt failure —
  // is unreadable for a reason we do not model, and is quoted rather than
  // guessed at: telling someone to install the Chrome they are running is a
  // fix that cannot work.
  if (/could not find .* cookies database|no such file or directory/i.test(detail)) return { reason: 'no-browser', detail }
  return { reason: 'unreadable', detail }
}

// One jar row: what the clients read (domain, name, value) and the line
// itself, so the rows a site needs can be written back as a jar for yt-dlp.
export type CookieRow = { domain: string; name: string; value: string; line: string }

// Netscape format: domain, flag, path, secure, expiry, name, value — tab
// separated; a leading #HttpOnly_ marks a row rather than commenting it out.
export function parseNetscapeJar(text: string): CookieRow[] {
  const rows: CookieRow[] = []
  for (const raw of text.split('\n')) {
    const line = raw.startsWith('#HttpOnly_') ? raw.slice('#HttpOnly_'.length) : raw
    if (line === '' || line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    rows.push({ domain: parts[0]!, name: parts[5]!, value: parts[6]!, line: raw })
  }
  return rows
}

// The rows one site needs: domain is the site or a parent of it
// (`.music.163.com` serves music.163.com), in jar order. Everything else in
// the browser's store — every other site's session — is dropped here, at the
// edge, so nothing but the mounted site's cookies is ever held.
export function siteRows(rows: readonly CookieRow[], site: string): CookieRow[] {
  return rows.filter((row) => {
    const domain = row.domain.replace(/^\./, '')
    return site === domain || site.endsWith(`.${domain}`)
  })
}

export function cookieHeader(rows: readonly CookieRow[], site: string): string {
  return siteRows(rows, site)
    .map((row) => `${row.name}=${row.value}`)
    .join('; ')
}

// A jar yt-dlp can load (`--cookies <path>`) for the duration of one call:
// written owner-only into its own temp directory, gone on release. This is
// how playback and the list reads reach the browser's login without a
// cookie-store unlock per spawn — the store is opened once per export.
export type CookieLease = { path: string; args: string[]; release: () => void }

export function writeJar(rows: readonly CookieRow[]): CookieLease {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-jar-'))
  const path = join(dir, 'cookies.txt')
  writeFileSync(path, `# Netscape HTTP Cookie File\n${rows.map((r) => r.line).join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 })
  return { path, args: ['--cookies', path], release: () => rmSync(dir, { recursive: true, force: true }) }
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
    // The extraction of the bogus URL fails; that is expected — the jar is
    // written by yt-dlp's exit regardless. A run that wrote no jar at all is
    // a real failure, and its own words say which one.
    let failure: unknown = null
    await run([...browserArgs(entry), '--cookies', path, '--simulate', '--no-warnings', '--ignore-errors', NO_URL]).catch((err: unknown) => {
      failure = err
      return ''
    })
    let text: string
    try {
      text = readFileSync(path, 'utf-8')
    } catch {
      const { reason, detail } = classifyCookieFailure(failure)
      throw new BrowserCookieError(entry.browser, reason, detail)
    }
    return parseNetscapeJar(text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
