// The music task's tools (spec 03-01 §2.3): search_music to gather candidates,
// submit_pick to commit to one.
//
// submit_pick is the terminal tool: it resolves the chosen ref, probes that the
// stream really plays, and only then calls `finish` — which ends the task with a
// typed TrackPick. A failure is returned to the model instead (ok: false), a
// non-terminating result that lets it pick another candidate. So "confirm the
// pick is actually playable", "hand the clip back", and "end the task" are one
// step, with no side channel and no re-resolve.
//
// With taste wired (spec 14 §2.4/§2.6) search_music takes a catalogue, and an
// auth-shaped failure comes back TYPED — the model is told that catalogue is
// closed for the rest of the task, and the Director hears about it once.

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type { Catalogue, ListeningData, MusicProvider, TaskTool, TrackPick } from '../contracts.ts'
import { ANNOUNCE_FIELD_DESCRIPTION } from '../prompts/music.ts'
import { previewTrap, SourceAuthError } from './sources/auth.ts'
import { sourceOfRef } from './sources/store.ts'
import { SOURCE_NAMES } from './sources/taste.ts'

// Pull-time playability check: given a resolved stream source, does it actually
// decode? Injected — the real one belongs to the audio engine (Phase 3), so this
// module stays free of it.
export type StreamProbe = (source: string) => Promise<boolean>

// The taste wiring (spec 14): which catalogues beyond youtube are mounted for
// this task, where an auth failure is reported, and the decoded-length probe
// the preview trap needs (netease refs only).
export type TasteToolOptions = {
  catalogues: () => readonly Catalogue[]
  onAuthFailure?: (err: SourceAuthError) => void
  probeDurationS?: (source: string) => Promise<number | null>
}

function reply(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text ? text : undefined
}

// How many names one widening call brings back: enough to break out of the
// first thing that came to mind, small enough to stay a cheap turn.
const SIMILAR_LIMIT = 8

const CATALOGUES = ['youtube', 'bilibili', 'netease'] as const

export function musicTools(
  provider: MusicProvider,
  finish: (pick: TrackPick) => void,
  probe?: StreamProbe,
  listening?: ListeningData,
  taste?: TasteToolOptions,
): TaskTool[] {
  // What this task may search: youtube always, the rest while mounted and
  // not yet closed by an auth failure in this very task.
  const mounted: Catalogue[] = ['youtube', ...(taste?.catalogues() ?? []).filter((c) => c !== 'youtube')]
  const closed = new Set<Catalogue>()
  const open = (): Catalogue[] => mounted.filter((c) => !closed.has(c))
  // Each candidate's stated length, for the preview trap at submit time.
  const stated = new Map<string, number>()

  const authResult = (err: SourceAuthError) => {
    const catalogue = err.source as Catalogue
    if ((CATALOGUES as readonly string[]).includes(catalogue)) closed.add(catalogue)
    taste?.onAuthFailure?.(err)
    return reply({
      ok: false,
      reason: 'auth',
      source: err.source,
      detail: err.reason,
      note: `${SOURCE_NAMES[err.source]} is unavailable for the rest of this task; do not search or submit it again. Catalogues still open: ${open().join(', ')}.`,
    })
  }

  const searchMusic = tool(
    'search_music',
    'Search for candidate tracks by query; returns candidates (ref, title, ' +
      'uploader, durationS) to judge before picking.' +
      (taste === undefined ? '' : ` Catalogues available now: ${mounted.join(', ')}.`),
    {
      query: z.string().describe('search terms for the track'),
      limit: z.number().int().min(1).max(10).optional().describe('max candidates (default 5)'),
      catalogue: z
        .enum(CATALOGUES)
        .optional()
        .describe(
          'where to search; default youtube. bilibili and netease are available only when mounted — the tool result says which are',
        ),
    },
    async (args) => {
      const catalogue = args.catalogue
      if (catalogue !== undefined && catalogue !== 'youtube') {
        if (!mounted.includes(catalogue)) return reply({ ok: false, reason: 'not-mounted', mounted: open() })
        if (closed.has(catalogue)) return reply({ ok: false, reason: 'unavailable', mounted: open() })
      }
      try {
        const candidates = await provider.search(args.query, args.limit, catalogue)
        for (const c of candidates) stated.set(c.ref, c.durationS)
        return reply({ candidates })
      } catch (err) {
        if (err instanceof SourceAuthError) return authResult(err)
        throw err
      }
    },
  )

  const submitPick = tool(
    'submit_pick',
    'Commit to ONE track by its ref, with a one-line reason. Resolves it to a ' +
      'playable source; on success this ends the task. If it fails, pick another.',
    {
      ref: z.string().describe("the chosen candidate's ref"),
      why: z.string().describe('one line: why this track'),
      title: z.string().optional().describe("the track's title"),
      artist: z.string().optional().describe("the track's artist/uploader"),
      announce: z.string().optional().describe(ANNOUNCE_FIELD_DESCRIPTION),
    },
    async (args) => {
      const ref = args.ref.trim()
      if (!ref) return reply({ ok: false, error: 'submit_pick requires a ref' })

      let clip
      try {
        clip = await provider.resolve(ref)
      } catch (err) {
        if (err instanceof SourceAuthError) return authResult(err)
        return reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      // The preview trap (spec 14 §2.6): NetEase hands a rights-less request a
      // 30 s clip with no error, so the decoded length is checked against the
      // length the candidate claimed.
      if (taste?.probeDurationS !== undefined && sourceOfRef(ref) === 'netease') {
        const probed = await taste.probeDurationS(clip.source)
        if (previewTrap(stated.get(ref) ?? 0, probed)) {
          return authResult(new SourceAuthError('netease', 'login-required', `preview clip of ${String(probed)}s`))
        }
      }
      // A resolved stream URL can still 403 in the decoder and never produce a
      // frame. Reject it now, during talk, so the announce never claims a track
      // that turns out silent.
      if (probe !== undefined && !(await probe(clip.source))) {
        return reply({ ok: false, error: `${ref} resolved but the stream did not play; pick another` })
      }

      const title = trimmed(args.title)
      const artist = trimmed(args.artist)
      const announce = trimmed(args.announce)
      const pick: TrackPick = {
        clip,
        ...(title !== undefined && { title }),
        ...(artist !== undefined && { artist }),
        ...(announce !== undefined && { announce }),
      }
      finish(pick)
      return reply({ ok: true, source: clip.source, title: pick.title ?? null })
    },
  )

  // Offered only when a data source is wired (spec 03-01 §2.3): with no key
  // configured the task is exactly its two-tool self.
  if (listening === undefined) return [searchMusic, submitPick]

  const similarMusic = tool(
    'similar_music',
    'Find what real listeners play alongside an artist or a track (co-listening ' +
      'data, not your own recollection). Pass artist alone for similar artists, ' +
      'or artist AND track for similar tracks. Widen with this before searching ' +
      'so the pick is not limited to what comes to mind first.',
    {
      artist: z.string().describe('the seed artist'),
      track: z.string().optional().describe('the seed track, for track-level neighbours'),
      limit: z.number().int().min(1).max(20).optional().describe(`max results (default ${SIMILAR_LIMIT})`),
    },
    async (args) => {
      const limit = args.limit ?? SIMILAR_LIMIT
      const track = trimmed(args.track)
      try {
        // A lookup that fails is a lost turn, never a lost song: the model
        // still has search_music and can submit without ever widening.
        return track === undefined
          ? reply({ artists: await listening.artists(args.artist, limit) })
          : reply({ tracks: await listening.tracks(args.artist, track, limit) })
      } catch (err) {
        return reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  // Widening to a fresh artist and then playing their one famous song is the
  // same habit one level down; this answers "which of theirs" with play counts.
  const topTracks = tool(
    'top_tracks',
    'What listeners actually play most by an artist, most-played first. Use it ' +
      'after finding an artist, so which of their songs airs is not decided by ' +
      'whichever title you happen to remember.',
    {
      artist: z.string().describe('the artist'),
      limit: z.number().int().min(1).max(20).optional().describe(`max tracks (default ${SIMILAR_LIMIT})`),
    },
    async (args) => {
      try {
        return reply({ tracks: await listening.topTracks(args.artist, args.limit ?? SIMILAR_LIMIT) })
      } catch (err) {
        return reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  return [searchMusic, similarMusic, topTracks, submitPick]
}
