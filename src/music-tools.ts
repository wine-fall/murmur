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

import type { MusicProvider, TaskTool, TrackPick } from './contracts.ts'

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

export function musicTools(
  provider: MusicProvider,
  finish: (pick: TrackPick) => void,
  probe?: StreamProbe,
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

  return [searchMusic, submitPick]
}
