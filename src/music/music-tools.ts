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

import { PLAY_ORDER, type AudioClip, type Catalogue, type MusicProvider, type PlayCatalogue, type TaskTool, type TrackCandidate, type TrackPick } from '../contracts.ts'
import { ANNOUNCE_FIELD_DESCRIPTION } from '../prompts/music.ts'
import { previewTrap, SourceAuthError } from './sources/auth.ts'
import { parseSegmentRef } from './music.ts'
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
  // Where a found song is PLAYED from, best first (spec 14 §2.13). Read per
  // submit like `catalogues`, so the /sources card lands on the next pick
  // rather than the next boot. Absent = the default order, so a caller that
  // never heard of the knob still relocates.
  playOrder?: () => readonly PlayCatalogue[]
  // The dev-log sink MusicProgrammer already feeds; the relocation line joins
  // music.search / music.resolve / music.probe there.
  debug?: (message: string) => void
}

function reply(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

// The label a pick is announced, ledgered and avoided under — one spelling, so
// a queued pick, an aired one and a submitted one are the same string.
export function trackLabel(pick: { readonly title?: string; readonly artist?: string }): string {
  return pick.artist === undefined ? (pick.title ?? 'music') : `${pick.title ?? 'music'} — ${pick.artist}`
}

// The artist back out of a label. The moment excludes what just played by
// ARTIST (spec 14 §2.12), and matching the whole label would let a title that
// happens to name another band drop that band's songs instead.
export function labelArtist(label: string): string {
  const cut = label.lastIndexOf(' — ')
  return cut === -1 ? '' : label.slice(cut + 3).trim()
}

// ponytail: trim + collapsed whitespace + case is the whole comparison. The
// ledger holds a band under both its simplified and its traditional spelling
// and those do NOT fold together here — a script-conversion table is far
// bigger than the repeat it would catch. Upgrade path: fold both sides through
// a converter before comparing.
function folded(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text ? text : undefined
}

const CATALOGUES = ['youtube', 'bilibili', 'netease', 'qqmusic', 'channels'] as const

// A relocated hit must be the same song: its title contains the submitted one
// (or the reverse — a catalogue that appends "(Official Audio)" is still it)
// and its length is within this much of what the original candidate claimed.
// ponytail: containment plus a window, no fuzzy distance and no pinyin table —
// a wrong relocation plays a different song, so the rule fails closed. Upgrade
// path in spec 14 §2.13.
const SAME_LENGTH_S = 20

// How long the whole relocation may take before the submit gives up on it and
// plays what the model picked. Measured: a real YouTube search + resolve +
// probe is ~5 s, so this leaves room for one miss and still lands well inside
// the talk that covers a pick.
const RELOCATE_BUDGET_MS = 15_000

// ponytail: one shared timer, raced against each step — not a per-call
// AbortSignal. yt-dlp is spawned by the provider and neither it nor ffmpeg
// takes a signal from here, so the only thing that can be cut short is the
// waiting; the abandoned spawn ends on its own ceiling.
function deadlineIn(ms: number): { passed: () => boolean; race: <T>(work: Promise<T>) => Promise<T> } {
  const until = performance.now() + ms
  return {
    passed: () => performance.now() >= until,
    race: <T,>(work: Promise<T>): Promise<T> =>
      Promise.race([
        work,
        new Promise<T>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('relocation budget spent')), Math.max(0, until - performance.now()))
          void work.finally(() => clearTimeout(timer)).catch(() => {})
        }),
      ]),
  }
}

// A different RECORDING of the same title is a different song to a listener:
// a karaoke backing track is 240 s of the right length with the right name.
// A hit whose words say it is one of these, where the submitted title did not,
// is refused — and refusing costs nothing but the speed-up.
const OTHER_RECORDING =
  // The Chinese markers are escaped because committed source is English only
  // (AGENTS.md): \u4f34\u594f backing track, \u7ffb\u5531 cover,
  // \u7eaf\u97f3\u4e50 instrumental, \u6296\u97f3\u7248 / dj\u7248 edits.
  /karaoke|instrumental|cover|remix|nightcore|sped up|slowed|8d audio|\u4f34\u594f|\u7ffb\u5531|\u7eaf\u97f3\u4e50|\u6296\u97f3\u7248|dj\u7248/

// Whoever the model said made it has to show up somewhere in the hit — its
// title or its uploader — before the pick is moved onto it. A catalogue that
// spells the artist differently simply keeps the pick where it was.
function sameArtist(hit: TrackCandidate, artist: string | undefined): boolean {
  if (artist === undefined) return true
  const wanted = folded(artist)
  return folded(hit.title).includes(wanted) || folded(hit.uploader).includes(wanted)
}

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
  avoid?: readonly string[],
): TaskTool[] {
  // What this task may not submit: the recently-played labels the situation
  // already names in words. The policy asks the model to skip them and a
  // prompt rule is advice — a repeat that reaches here is turned back, at the
  // cost of one tool turn.
  const avoided = new Set((avoid ?? []).map(folded))
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


  // Resolve a ref and prove it will really play: the NetEase preview trap
  // (spec 14 §2.6) and then the decoder probe, which the trap's own read
  // stands in for when it got one. Shared by the submitted ref and by every
  // relocation attempt, so a relocated pick is held to the same bar.
  type Opened =
    | { ok: true; clip: AudioClip }
    | { ok: false; why: 'dead' | 'resolve-failed'; error: string }
    | { ok: false; why: 'auth'; err: SourceAuthError }
  const openClip = async (ref: string): Promise<Opened> => {
    let clip: AudioClip
    try {
      clip = await provider.resolve(ref)
    } catch (err) {
      if (err instanceof SourceAuthError) return { ok: false, why: 'auth', err }
      return { ok: false, why: 'resolve-failed', error: err instanceof Error ? err.message : String(err) }
    }
    // The length the trap read off the stream, null when it never ran or read
    // nothing — the playability probe below reads it.
    let trapRead: number | null = null
    if (taste?.probeDurationS !== undefined && sourceOfRef(ref) === 'netease') {
      trapRead = await taste.probeDurationS(clip.source, clip.headers, clip.segment?.startS)
      // A segment clip is meant to be its chapter's length; a whole track is
      // meant to be the length its candidate claimed.
      const expected = clip.segment === undefined ? (stated.get(ref) ?? 0) : clip.segment.endS - clip.segment.startS
      if (previewTrap(expected, trapRead)) {
        const err = new SourceAuthError('netease', 'login-required', `preview clip of ${String(trapRead)}s`)
        return { ok: false, why: 'auth', err }
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
      return { ok: false, why: 'dead', error: `${ref} resolved but the stream did not play; pick another` }
    }
    return { ok: true, clip }
  }

  // Where the pick will PLAY from (spec 14 §2.13). The model chose the song;
  // this chooses the CDN, model-free, and every failure simply falls through
  // to the ref the model actually submitted. null = nothing better was found,
  // or there was nothing better to look for.
  const relocate = async (ref: string, title: string, artist: string | undefined): Promise<AudioClip | null> => {
    // A chapter of one specific upload has no equivalent anywhere else.
    if (parseSegmentRef(ref).segment !== undefined) return null
    const order = taste?.playOrder?.() ?? PLAY_ORDER
    // An unknown host is a YouTube ref in everything but spelling — that is
    // where a bare search sends the model, and where `channels` uploads live.
    const own: PlayCatalogue = sourceOfRef(ref) ?? 'youtube'
    const rank = order.indexOf(own)
    const better = (rank === -1 ? order : order.slice(0, rank)).filter((c) => open().includes(c))
    if (better.length === 0) return null

    const wanted = folded(title)
    const length = stated.get(ref)
    let reason = 'no-hit'
    // Relocation is an optimisation, and an optimisation may not become the
    // thing the pick waits on: a single yt-dlp call can sit for 90 s, and the
    // Director is filling that silence with talk. Past this the original ref
    // resolves as it always would (codex review).
    const deadline = deadlineIn(RELOCATE_BUDGET_MS)
    for (const catalogue of better) {
      if (deadline.passed()) {
        reason = 'timed-out'
        break
      }
      let hits: TrackCandidate[]
      try {
        hits = await deadline.race(provider.search(`${artist ?? ''} ${title}`.trim(), 5, catalogue))
      } catch (err) {
        // A lost login here closes that catalogue for the task like any other
        // auth failure, but it must never end a submit that was going fine.
        if (err instanceof SourceAuthError) authResult(err)
        reason = err instanceof SourceAuthError ? 'auth' : deadline.passed() ? 'timed-out' : 'search-failed'
        continue
      }
      for (const hit of hits) stated.set(hit.ref, hit.durationS)
      const match = hits.find((hit) => {
        const found = folded(hit.title)
        const sameSong = found.includes(wanted) || wanted.includes(found)
        if (!sameSong || !sameArtist(hit, artist)) return false
        if (OTHER_RECORDING.test(found) && !OTHER_RECORDING.test(wanted)) return false
        return length === undefined || Math.abs(hit.durationS - length) <= SAME_LENGTH_S
      })
      if (match === undefined) continue
      const opened = await deadline.race(openClip(match.ref)).catch((): Opened => ({ ok: false, why: 'dead', error: 'timed out' }))
      if (opened.ok) {
        taste?.debug?.(`music.relocate from=${own} to=${catalogue} ok`)
        return opened.clip
      }
      if (opened.why === 'auth') authResult(opened.err)
      reason = opened.why
    }
    taste?.debug?.(`music.relocate from=${own} none reason=${reason}`)
    return null
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
      if (catalogue === 'channels') {
        const found = channels?.search(args.query, args.limit) ?? []
        for (const c of found) stated.set(c.ref, c.durationS)
        return reply({ candidates: found })
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

      const title = trimmed(args.title)
      const artist = trimmed(args.artist)
      // Before the resolve: a repeat costs a tool turn, never a network round.
      // Only a pick that names itself can be recognised as one — a submission
      // with no title carries the placeholder label, which is an absence of
      // identity and not a song to match on.
      const label = trackLabel({ ...(title !== undefined && { title }), ...(artist !== undefined && { artist }) })
      if (title !== undefined && avoided.has(folded(label))) {
        return reply({ ok: false, error: `${label} was played recently; pick a different song` })
      }

      // Found is not where it plays from (spec 14 §2.13): a song the model
      // found on a slow catalogue is played from the fastest one that also
      // has it. Only a pick that names itself can be looked for elsewhere.
      let clip = title === undefined ? null : await relocate(ref, title, artist)
      if (clip === null) {
        const opened = await openClip(ref)
        if (!opened.ok) {
          if (opened.why === 'auth') return authResult(opened.err)
          return reply({ ok: false, error: opened.error })
        }
        clip = opened.clip
      }

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
