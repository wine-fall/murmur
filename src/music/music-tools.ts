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

import type { Catalogue, MusicProvider, TaskTool, TrackCandidate, TrackPick } from '../contracts.ts'
import { ANNOUNCE_FIELD_DESCRIPTION } from '../prompts/music.ts'
import { previewTrap, SourceAuthError } from './sources/auth.ts'
import { sourceOfRef } from './sources/store.ts'
import { SOURCE_NAMES } from './sources/taste.ts'

// Pull-time playability check: given a resolved stream source, does it actually
// decode? Injected — the real one belongs to the audio engine (Phase 3), so this
// module stays free of it.
// `startS` is a segment clip's offset (spec 14 §2.9): the probe has to open
// the slice that will play, not the head of a two-hour upload.
export type StreamProbe = (
  source: string,
  headers?: Readonly<Record<string, string>>,
  startS?: number,
) => Promise<boolean>

// The taste wiring (spec 14): which catalogues beyond youtube are mounted for
// this task, where an auth failure is reported, and the decoded-length probe
// the preview trap needs (netease refs only).
export type TasteToolOptions = {
  catalogues: () => readonly Catalogue[]
  onAuthFailure?: (err: SourceAuthError) => void
  probeDurationS?: (
    source: string,
    headers?: Readonly<Record<string, string>>,
    startS?: number,
  ) => Promise<number | null>
}

function reply(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text ? text : undefined
}

const CATALOGUES = ['youtube', 'bilibili', 'netease', 'qqmusic', 'channels'] as const

// The curated-channel pool (spec 14 §2.9), read live: a local match over the
// recent uploads of the channels the listener curated. It is offered only
// while it holds something, and searching it never touches the network.
export type ChannelCatalogue = {
  count: () => number
  search: (query: string, limit?: number) => TrackCandidate[]
}

export function musicTools(
  provider: MusicProvider,
  finish: (pick: TrackPick) => void,
  probe?: StreamProbe,
  taste?: TasteToolOptions,
  channels?: ChannelCatalogue,
): TaskTool[] {
  // What this task may search: youtube always, the rest while mounted and
  // not yet closed by an auth failure in this very task. An empty channel
  // pool is not mounted — there is nothing in it to find.
  const mounted: Catalogue[] = [
    'youtube',
    ...(taste?.catalogues() ?? []).filter((c) => c !== 'youtube'),
    ...(channels !== undefined && channels.count() > 0 ? (['channels'] as const) : []),
  ]
  const closed = new Set<Catalogue>()
  const open = (): Catalogue[] => mounted.filter((c) => !closed.has(c))
  // Each candidate's stated length, for the preview trap at submit time.
  const stated = new Map<string, number>()

  // A lost login or a rate limit closes the catalogue for the task; a geo
  // block is one track's problem and only costs that pick.
  const authResult = (err: SourceAuthError) => {
    const catalogue = err.source as Catalogue
    const closes = err.reason !== 'geo' && (CATALOGUES as readonly string[]).includes(catalogue)
    if (closes) closed.add(catalogue)
    taste?.onAuthFailure?.(err)
    return reply({
      ok: false,
      reason: 'auth',
      source: err.source,
      detail: err.reason,
      note: closes
        ? `${SOURCE_NAMES[err.source]} is unavailable for the rest of this task; do not search or submit it again. Catalogues still open: ${open().join(', ')}.`
        : `${SOURCE_NAMES[err.source]} cannot serve that track from here; pick another.`,
    })
  }

  const searchMusic = tool(
    'search_music',
    'Search for candidate tracks by query; returns candidates (ref, title, ' +
      'uploader, durationS) to judge before picking.' +
      (taste === undefined && channels === undefined ? '' : ` Catalogues available now: ${mounted.join(', ')}.`),
    {
      query: z.string().describe('search terms for the track'),
      limit: z.number().int().min(1).max(10).optional().describe('max candidates (default 5)'),
      catalogue: z
        .enum(CATALOGUES)
        .optional()
        .describe(
          'where to search; default youtube. bilibili, netease, qqmusic and channels are available only when mounted — the tool result says which are',
        ),
    },
    async (args) => {
      const catalogue = args.catalogue
      if (catalogue !== undefined && catalogue !== 'youtube' && !mounted.includes(catalogue)) {
        return reply({ ok: false, reason: 'not-mounted', mounted: open() })
      }
      if (closed.has(catalogue ?? 'youtube')) return reply({ ok: false, reason: 'unavailable', mounted: open() })
      // The curated channels are already on disk: matched here, so a search of
      // them costs nothing and cannot fail (spec 14 §2.9).
      if (catalogue === 'channels') return reply({ candidates: channels?.search(args.query, args.limit) ?? [] })
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
      // The length the trap read off the stream, null when it never ran or read
      // nothing — the playability probe below reads it.
      let trapRead: number | null = null
      if (taste?.probeDurationS !== undefined && sourceOfRef(ref) === 'netease') {
        trapRead = await taste.probeDurationS(clip.source, clip.headers, clip.segment?.startS)
        // A segment clip is meant to be its chapter's length; a whole track is
        // meant to be the length its candidate claimed.
        const expected = clip.segment === undefined ? (stated.get(ref) ?? 0) : clip.segment.endS - clip.segment.startS
        if (previewTrap(expected, trapRead)) {
          return authResult(new SourceAuthError('netease', 'login-required', `preview clip of ${String(trapRead)}s`))
        }
      }
      // A resolved stream URL can still 403 in the decoder and never produce a
      // frame. Reject it now, during talk, so the announce never claims a track
      // that turns out silent.
      // Unless the trap above just opened this very stream and read a real
      // length off it — that IS the proof, and opening it twice costs another
      // 13-15 s against a slow NetEase CDN, where the probe's own 15 s ceiling
      // then calls a live stream dead and the whole pick starts over (issue
      // #164). A trap that read nothing proves nothing, so the probe still runs.
      if (trapRead === null && probe !== undefined && !(await probe(clip.source, clip.headers, clip.segment?.startS))) {
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

  return [searchMusic, submitPick]
}
