// A yt-dlp flat list read (spec 14 §2.8): one `--dump-json --flat-playlist`
// call for a bounded page of entries, each a title with whatever the list
// knows about it. The parse is the search parser's — a list entry and a
// search hit are the same yt-dlp shape.

import type { YtDlpRunner } from '../music.ts'
import { parseSearchOutput } from '../music.ts'

export type FlatEntry = { title: string; uploader: string; durationS: number; url: string }

export async function flatEntries(run: YtDlpRunner, target: string, cookie: readonly string[], bound: number): Promise<FlatEntry[]> {
  const stdout = await run(['--dump-json', '--flat-playlist', '--playlist-end', String(bound), '--no-warnings', ...cookie, target])
  return parseSearchOutput(stdout, bound).map((c) => ({ title: c.title, uploader: c.uploader, durationS: c.durationS, url: c.ref }))
}
