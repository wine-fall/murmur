// The pixel pet's substrate (spec 10 §3.7.1): sprite assets, the pose the
// program state selects, and the absence the pet greets (§3.7.3). Art direction
// is deferred (§6.1) — what is pinned here is the machinery under it, so a later
// creative session can replace every .pix file and nothing else.
//
// Pure client modules, held by the fast layer for the reason §3.9 gives: the
// painted frame cannot be unit-asserted, but which glyph and which pose can.

import { describe, expect, it } from 'vitest'

import {
  awayGreeting,
  bandLayout,
  loadPoses,
  parseFrames,
  POSE_FPS,
  poseFor,
  type PoseName,
} from '../tui/src/pet.ts'

const POSES = loadPoses()

describe('the committed sprite assets', () => {
  it('ships a frame set for every pose the state feed can ask for', () => {
    const asked: PoseName[] = ['idle', 'talk', 'music', 'doze', 'wake']
    for (const pose of asked) expect(POSES[pose]!.length).toBeGreaterThan(0)
  })

  it('animates the idle loop and holds the reaction poses still', () => {
    // §3.7.1: an idle loop at 2-8fps. A pose that reacts to state does not need
    // frames to read as alive; the pose change IS the reaction.
    expect(POSES.idle.length).toBeGreaterThan(1)
    for (const [pose, fps] of Object.entries(POSE_FPS)) {
      expect(fps, pose).toBeGreaterThanOrEqual(2)
      expect(fps, pose).toBeLessThanOrEqual(8)
    }
  })

  it('holds every frame of every pose to one size, so the band never jumps', () => {
    const frames = Object.values(POSES).flat()
    const sizes = new Set(frames.map((frame) => `${frame.length}x${frame[0]!.length}`))
    expect(sizes.size).toBe(1)
    // Half-block cells pair two pixel rows, so an odd count would drop one.
    expect(frames[0]!.length % 2).toBe(0)
  })

  it('uses only pixel keys the renderers know: figure, outline, sparkle, empty', () => {
    for (const frame of Object.values(POSES).flat()) {
      for (const glyph of frame.join('')) {
        expect(['x', 'w', 's', '.'], `unknown key ${glyph}`).toContain(glyph)
      }
    }
  })

  it('keeps the figure two-tone: cream fill AND the warm outline', () => {
    const idle = POSES.idle[0]!.join('')
    expect(idle).toContain('x')
    expect(idle).toContain('w')
  })
})

describe('parseFrames', () => {
  it('splits frames on a blank line', () => {
    expect(parseFrames('ab\ncd\n\nef\ngh\n')).toEqual([
      ['ab', 'cd'],
      ['ef', 'gh'],
    ])
  })

  it('pads a row an editor trimmed, rather than rendering a ragged sprite', () => {
    // Trailing transparent pixels are trailing spaces' cousins: every tool in
    // the chain wants to eat them.
    expect(parseFrames('ab..\ncd')).toEqual([['ab..', 'cd..']])
  })

  it('ignores trailing blank lines instead of emitting an empty frame', () => {
    expect(parseFrames('ab\n\n\n')).toEqual([['ab']])
    expect(parseFrames('')).toEqual([])
  })
})

describe('poseFor (spec 10 §3.2-D: the display-state inventory)', () => {
  it('dozes when the room is empty — the pet explains the quiet', () => {
    expect(poseFor({ kind: 'gap', activity: 'away' })).toBe('doze')
  })

  it('follows the segment the rest of the time', () => {
    expect(poseFor({ kind: 'talk' })).toBe('talk')
    expect(poseFor({ kind: 'music', nowPlaying: 'a song' })).toBe('music')
    expect(poseFor({ kind: 'gap' })).toBe('idle')
    expect(poseFor({ kind: 'talk', activity: 'engaged' })).toBe('talk')
  })

  it('idles before the engine has said anything', () => {
    expect(poseFor(null)).toBe('idle')
  })
})

describe('bandLayout (spec 10 §3.3: the alive band, pet optional)', () => {
  it('shows the pet by default — the off switch is opt-in', () => {
    expect(bandLayout({}).pet).toBe(true)
    expect(bandLayout({ MURMUR_TUI_PET: '1' }).pet).toBe(true)
  })

  it('hides the pet on MURMUR_TUI_PET=0, and on the spellings of "0" people type', () => {
    expect(bandLayout({ MURMUR_TUI_PET: '0' }).pet).toBe(false)
    expect(bandLayout({ MURMUR_TUI_PET: ' 0 ' }).pet).toBe(false)
    for (const off of ['off', 'false', 'no', 'OFF']) {
      expect(bandLayout({ MURMUR_TUI_PET: off }).pet, off).toBe(false)
    }
  })

  it('gives the spectrum the whole band when the pet is off — no dead hole', () => {
    // The gutter exists to separate the two; with nothing to separate, it is a
    // one-column indent the bars do not start at.
    expect(bandLayout({ MURMUR_TUI_PET: '0' }).vizPadLeft).toBe(0)
    expect(bandLayout({}).vizPadLeft).toBeGreaterThan(0)
  })

  it('treats an unusable value as the default, never as an outage', () => {
    expect(bandLayout({ MURMUR_TUI_PET: 'maybe' }).pet).toBe(true)
    expect(bandLayout({ MURMUR_TUI_PET: '' }).pet).toBe(true)
  })

  // spec 12 §3.7: the knob lives in the settings layer now; the env survives as
  // the client-local final override — set env beats setting, unset env defers.
  it('defers to the live tuiPet setting when the env says nothing', () => {
    expect(bandLayout({}, false).pet).toBe(false)
    expect(bandLayout({}, false).vizPadLeft).toBe(0)
    expect(bandLayout({}, true).pet).toBe(true)
    expect(bandLayout({ MURMUR_TUI_PET: '' }, false).pet).toBe(false)
  })

  it('an explicitly set env still overrides the setting, both ways', () => {
    expect(bandLayout({ MURMUR_TUI_PET: '0' }, true).pet).toBe(false)
    expect(bandLayout({ MURMUR_TUI_PET: '1' }, false).pet).toBe(true)
  })
})

describe('awayGreeting (spec 10 §3.7.3: alive across absence)', () => {
  it('says nothing when there is no absence to acknowledge', () => {
    expect(awayGreeting(undefined)).toBeNull()
    expect(awayGreeting(0)).toBeNull()
    // Stepping out for ten minutes is not an absence; greeting it would be noise.
    expect(awayGreeting(600)).toBeNull()
  })

  it('names the gap in the unit a person would use', () => {
    expect(awayGreeting(3 * 3600)).toMatch(/3 hours/)
    expect(awayGreeting(3600 + 60)).toMatch(/an hour/)
    expect(awayGreeting(3 * 86_400)).toMatch(/3 days/)
    expect(awayGreeting(30 * 86_400)).toMatch(/a while/)
  })

  it('has no decay mechanics — a long absence is still a welcome', () => {
    // tama96's lesson (§3.7.3): murmur is a companion, not a chore.
    for (const seconds of [3600, 86_400, 400 * 86_400]) {
      expect(awayGreeting(seconds)).not.toMatch(/died|hungry|neglect|sad/i)
    }
  })
})
