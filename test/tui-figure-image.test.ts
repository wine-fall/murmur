// The figure as a real raster (spec 10 §6.1): kitty-graphics terminals draw
// the whisper-girl as an actual PNG, finer than any character mosaic. The
// escape framing is deterministic wire format — unit-assertable.
/* oxlint-disable no-control-regex -- the wire format under test IS escape bytes */

import { describe, expect, it } from 'vitest'

import {
  deleteFigures,
  encodeFigurePng,
  figurePen,
  figureScale,
  placeFigure,
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

describe('placeFigure (kitty graphics APC framing)', () => {
  const png = Buffer.from('fake png bytes')

  it('saves the cursor, moves to the cell, transmits, and restores', () => {
    const seq = placeFigure(png, 5, 40, 1)
    expect(seq.startsWith('\x1b7\x1b[5;40H')).toBe(true)
    expect(seq.endsWith('\x1b8')).toBe(true)
  })

  it('declares PNG transmit-and-display without moving the cursor', () => {
    const seq = placeFigure(png, 1, 1, 3)
    expect(seq).toContain('f=100')
    expect(seq).toContain('a=T')
    expect(seq).toContain('C=1')
    expect(seq).toContain('i=3')
    expect(seq).toContain(png.toString('base64'))
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

describe('figureScale (device pixels per sprite pixel)', () => {
  it('spans roughly the target cells at a known cell width', () => {
    // 16 cells * 20px / 42 sprite cols ~= 8
    expect(figureScale(20, 42)).toBe(8)
  })

  it('falls back when the terminal will not say', () => {
    expect(figureScale(0, 42)).toBe(3)
  })
})
