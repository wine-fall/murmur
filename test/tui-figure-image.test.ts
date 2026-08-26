// The figure as a real raster (spec 10 §6.1): kitty-graphics terminals draw
// the whisper-girl as an actual PNG, finer than any character mosaic. The
// escape framing is deterministic wire format — unit-assertable.
/* oxlint-disable no-control-regex -- the wire format under test IS escape bytes */

import { describe, expect, it } from 'vitest'

import {
  cellSizeFrom,
  deleteFigures,
  encodeFigurePng,
  figurePen,
  figureRaster,
  figureScale,
  placeFigure,
  stagePlan,
} from '../tui/src/figure-image.ts'

describe('figurePen (who can hold a raster at all)', () => {
  it('reads the explicit override first', () => {
    expect(figurePen({ MURMUR_TUI_FIGURE: 'sprite', TERM_PROGRAM: 'ghostty' })).toBe('sprite')
    expect(figurePen({ MURMUR_TUI_FIGURE: 'image' })).toBe('image')
  })

  it('grants the raster to kitty-graphics terminals, sprite to the rest', () => {
    expect(figurePen({ TERM_PROGRAM: 'ghostty' })).toBe('image')
    expect(figurePen({ TERM: 'xterm-kitty' })).toBe('image')
    expect(figurePen({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('sprite')
    expect(figurePen({})).toBe('sprite')
  })
})

describe('figureRaster (the raster needs a pixel pitch, not just a claim)', () => {
  it('holds the raster when the terminal both speaks kitty and reported its cells', () => {
    expect(figureRaster('image', { width: 9, height: 25 })).toBe(true)
  })

  it('falls back to the sprite when the terminal never reported its cell size', () => {
    // tmux, ssh, any terminal ignoring the window-pixel query: TERM_PROGRAM
    // still says ghostty, so the pen says image — but a PNG nothing renders
    // leaves an EMPTY sky, and the sprite has to take the figure back.
    expect(figureRaster('image', null)).toBe(false)
  })

  it('never grants the raster to a sprite terminal', () => {
    expect(figureRaster('sprite', { width: 9, height: 25 })).toBe(false)
  })
})

describe('placeFigure (kitty graphics APC framing)', () => {
  const png = Buffer.from('fake png bytes')

  it('saves the cursor, moves to the cell, transmits, and restores', () => {
    const seq = placeFigure(png, 5, 40, 1)
    expect(seq).toContain('\x1b7\x1b[5;40H')
    expect(seq).toContain('\x1b8')
  })

  it('wraps the whole placement in a synchronized update, so the parked cursor never shows', () => {
    // The renderer's frames end with the hardware cursor VISIBLE on the input
    // line. This write happens between frames: without the 2026 guard the
    // terminal displays the cursor sitting on the anchor cell for the whole
    // base64 stream — a phantom cursor blinking at the image corner.
    const seq = placeFigure(png, 5, 40, 1)
    expect(seq.startsWith('\x1b[?2026h\x1b7\x1b[5;40H')).toBe(true)
    expect(seq.endsWith('\x1b8\x1b[?2026l')).toBe(true)
  })

  it('declares PNG transmit-and-display without moving the cursor', () => {
    const seq = placeFigure(png, 1, 1, 3)
    expect(seq).toContain('f=100')
    expect(seq).toContain('a=T')
    expect(seq).toContain('C=1')
    expect(seq).toContain('i=3')
    expect(seq).toContain(png.toString('base64'))
  })

  it('names its placement, so a retransmission replaces instead of piling up', () => {
    // Without a placement id the protocol creates a NEW placement per display:
    // an animation loop then leaks placements for as long as it runs, and the
    // terminal composites every one of them. Same image id AND placement id is
    // what makes the second transmission replace the first.
    expect(placeFigure(png, 1, 1, 3)).toMatch(/p=\d/)
    expect(placeFigure(png, 1, 1, 3)).toContain('i=3,p=3')
    expect(placeFigure(png, 1, 1, 2)).toContain('i=2,p=2')
  })

  it('chunks a large payload and chains the continuations', () => {
    const big = Buffer.alloc(9000, 7)
    const seq = placeFigure(big, 1, 1, 1)
    const chunks = seq.match(/\x1b_G[^\x1b]*\x1b\\/g)!
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toContain('m=1')
    expect(chunks.at(-1)).toContain('m=0')
    // Only the first chunk carries the control keys.
    expect(chunks.at(-1)).not.toContain('a=T')
    // The payload survives reassembly.
    const joined = chunks.map((c) => c.replace(/^\x1b_G[^;]*;/, '').replace(/\x1b\\$/, '')).join('')
    expect(joined).toBe(big.toString('base64'))
  })

  it('deleteFigures clears every placement quietly', () => {
    expect(deleteFigures()).toBe('\x1b_Ga=d,d=A,q=2\x1b\\')
  })
})

describe('encodeFigurePng (the sprite as a real raster)', () => {
  it('emits a valid PNG at sprite-size times scale', () => {
    const png = encodeFigurePng(['xw', '.s'], 3)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // IHDR width/height at offsets 16/20.
    expect(png.readUInt32BE(16)).toBe(6)
    expect(png.readUInt32BE(20)).toBe(6)
  })
})

describe('encodeFigurePng fade (the dozer dims toward the room)', () => {
  it('changes the emitted pixels without changing the geometry', () => {
    const awake = encodeFigurePng(['xw', 'ws'], 2)
    const dozing = encodeFigurePng(['xw', 'ws'], 2, 0.5)
    expect(dozing.readUInt32BE(16)).toBe(awake.readUInt32BE(16))
    expect(dozing.equals(awake)).toBe(false)
  })
})

describe('cellSizeFrom (cell pixels out of the window resolution)', () => {
  it('divides the window resolution across the cell grid', () => {
    expect(cellSizeFrom({ width: 1800, height: 1250 }, 200, 50)).toEqual({ width: 9, height: 25 })
  })

  it('returns null when the terminal never answered', () => {
    expect(cellSizeFrom(null, 200, 50)).toBeNull()
  })

  it('returns null on a degenerate grid or resolution', () => {
    expect(cellSizeFrom({ width: 1800, height: 1250 }, 0, 50)).toBeNull()
    expect(cellSizeFrom({ width: 0, height: 0 }, 200, 50)).toBeNull()
  })
})

describe('figureScale (device pixels per sprite pixel)', () => {
  it('spans roughly the target cells at a known cell width', () => {
    // 16 cells * 20px / 42 sprite cols ~= 8
    expect(figureScale(20, 42)).toBe(8)
  })

  it('falls back when the terminal will not say', () => {
    expect(figureScale(0, 42)).toBe(3)
  })
})

// The figure under the spotlight (§3.2-B amended): while a question is on the
// card the sky stays, hushed like the room — the raster yields only when the
// card climbs into its rows, because a kitty image sits ABOVE text cells and
// would cover it.
describe('stagePlan (whether the figure keeps the stage while the card is up)', () => {
  it('normal without a hush; hushed above the card; off when the card reaches it', () => {
    expect(stagePlan(false, null, 5, 8)).toBe('normal')
    expect(stagePlan(true, null, 5, 8)).toBe('hushed')
    expect(stagePlan(true, 20, 5, 8)).toBe('hushed') // bottom row 13 clears row 20
    expect(stagePlan(true, 12, 5, 8)).toBe('off') // 13 >= 12 would cover the card
    expect(stagePlan(true, 5, 5, 8)).toBe('off')
  })

  it('the occluded rows yield even without a hush — the command menu floats undimmed (codex review)', () => {
    expect(stagePlan(false, 12, 5, 8)).toBe('off') // a raster composites above the menu
    expect(stagePlan(false, 20, 5, 8)).toBe('normal') // clear of it: full light
  })
})
