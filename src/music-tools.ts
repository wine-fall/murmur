// The music task's tools (spec 03-01 §2.3): search_music to gather candidates,
// submit_pick to commit to one.
//
// submit_pick is the terminal tool: it resolves the chosen ref, probes that the
// stream really plays, and only then calls `finish` — which ends the task with a
// typed TrackPick. A failure is returned to the model instead (ok: false), a
// non-terminating result that lets it pick another candidate. So "confirm the
// pick is actually playable", "hand the clip back", and "end the task" are one
// step, with no side channel and no re-resolve.

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type { MusicProvider, SimilarMusic, TaskTool, TrackPick } from './contracts.ts'

// Pull-time playability check: given a resolved stream source, does it actually
// decode? Injected — the real one belongs to the audio engine (Phase 3), so this
// module stays free of it.
export type StreamProbe = (source: string) => Promise<boolean>

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

export function musicTools(
  provider: MusicProvider,
  finish: (pick: TrackPick) => void,
  probe?: StreamProbe,
  similar?: SimilarMusic,
): TaskTool[] {
  const searchMusic = tool(
    'search_music',
    'Search for candidate tracks by query; returns candidates (ref, title, ' +
      'uploader, durationS) to judge before picking.',
    {
      query: z.string().describe('search terms for the track'),
      limit: z.number().int().min(1).max(10).optional().describe('max candidates (default 5)'),
    },
    async (args) => reply({ candidates: await provider.search(args.query, args.limit) }),
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
      announce: z
        .string()
        .optional()
        .describe(
          'one short in-persona spoken line introducing the track (the DJ ' +
            "'up next'), in the persona's language",
        ),
    },
    async (args) => {
      const ref = args.ref.trim()
      if (!ref) return reply({ ok: false, error: 'submit_pick requires a ref' })

      let clip
      try {
        clip = await provider.resolve(ref)
      } catch (err) {
        return reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
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
  if (similar === undefined) return [searchMusic, submitPick]

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
          ? reply({ artists: await similar.artists(args.artist, limit) })
          : reply({ tracks: await similar.tracks(args.artist, track, limit) })
      } catch (err) {
        return reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  return [searchMusic, similarMusic, submitPick]
}
