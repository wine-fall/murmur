// The figure as a real raster (spec 10 §6.1): terminals speaking the kitty
// graphics protocol draw the whisper-girl as an actual PNG at the design's
// own pixel pitch — finer than any character mosaic can go. Everyone else
// keeps the octant/half-block sprite. The sky stays characters either way;
// only the figure earns pixels.

import { deflateSync } from 'node:zlib'

import type { Sprite } from './pet.ts'

// Structurally @opentui/core's PixelResolution — declared here so the engine's
// tsc pass, which follows the tests into this file, needs no tui dependency.
type PixelResolution = { width: number; height: number }

export type FigurePen = 'image' | 'sprite'

// MURMUR_TUI_FIGURE=image|sprite overrides; otherwise kitty-graphics
// terminals (Ghostty, kitty) get the raster.
export function figurePen(env: NodeJS.ProcessEnv): FigurePen {
  const forced = (env.MURMUR_TUI_FIGURE ?? '').trim().toLowerCase()
  if (forced === 'image' || forced === 'sprite') return forced
  const program = (env.TERM_PROGRAM ?? '').toLowerCase()
  if (program === 'ghostty') return 'image'
  if ((env.TERM ?? '').includes('kitty')) return 'image'
  return 'sprite'
}

// The raster's inks are the design's own sampled colors — brighter than the
// log's text cream on purpose, the way the concept's figure pops off the sky.
const RGBA: Record<string, [number, number, number, number]> = {
  x: [0xfc, 0xf8, 0xe7, 255],
  w: [0xb0, 0x78, 0x49, 255],
  s: [0xea, 0xb4, 0x8c, 255],
}

export function crc32(bytes: Buffer): number {
  let crc = 0xff_ff_ff_ff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xed_b8_83_20 & -(crc & 1))
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, tail])
}

// The room's ground, for fading a dozing figure toward the dark.
const BG: [number, number, number] = [0x09, 0x0e, 0x17]

// A .pix sprite as a real PNG at an integer scale — nearest-neighbour by
// construction, transparent ground, pixel-art crisp at any cell size. fade
// pulls every ink toward the room the way the sprite path dims a dozer.
export function encodeFigurePng(sprite: Sprite, scale: number, fade = 0): Buffer {
  const rows = sprite.length
  const cols = sprite[0]?.length ?? 0
  const width = cols * scale
  const height = rows * scale
  const inks = new Map<string, [number, number, number, number]>()
  for (const [key, [r, g, b, a]] of Object.entries(RGBA)) {
    inks.set(key, [
      Math.round(r + (BG[0] - r) * fade),
      Math.round(g + (BG[1] - g) * fade),
      Math.round(b + (BG[2] - b) * fade),
      a,
    ])
  }
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const at = y * (1 + width * 4) + 1
    const line = sprite[Math.floor(y / scale)]!
    for (let x = 0; x < width; x++) {
      const ink = inks.get(line[Math.floor(x / scale)]!)
      if (ink !== undefined) raw.set(ink, at + x * 4)
    }
  }
  return packPng(width, height, raw)
}

// RGBA scanlines (each prefixed with a filter-0 byte) into a finished PNG.
// Level-1 deflate: these frames stream at animation rate, and speed beats
// the last few KB.
export function packPng(width: number, height: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// How many device pixels one sprite pixel should get so the figure spans about
// `targetCells` terminal columns. cellWidth 0/unknown falls back to 3 — the
// half-block-era footprint.
export function figureScale(cellWidth: number, spriteCols: number, targetCells = 16): number {
  if (cellWidth <= 0 || spriteCols <= 0) return 3
  return Math.max(1, Math.round((targetCells * cellWidth) / spriteCols))
}

// The protocol caps one escape's payload at 4096 base64 chars.
const CHUNK = 4096

// One placement: save the cursor, park it on the anchor cell (1-based), stream
// the PNG (f=100) as transmit-and-display (a=T) without disturbing the cursor
// (C=1), quietly (q=2), above the sky's text cells (z=1), then restore. The
// terminal keeps the image until it is deleted; text repaints do not touch it.
//
// The placement is NAMED (p=, one per image id). A display without one creates
// a fresh placement every time, so an animation loop leaves the terminal
// compositing thousands of stale placements — the whole machine slows down.
// Same image id + same placement id means the next frame replaces this one.
export function placeFigure(png: Buffer, row: number, col: number, id: number, z = 1): string {
  const b64 = png.toString('base64')
  const parts: string[] = []
  for (let at = 0; at < b64.length; at += CHUNK) parts.push(b64.slice(at, at + CHUNK))
  const seq = parts
    .map((part, index) => {
      const head = index === 0 ? `f=100,a=T,C=1,q=2,z=${z},i=${id},p=${id},` : ''
      const more = index === parts.length - 1 ? 'm=0' : 'm=1'
      return `\x1b_G${head}${more};${part}\x1b\\`
    })
    .join('')
  return `\x1b7\x1b[${row};${col}H${seq}\x1b8`
}

// Drop every image placement — resize repaints and shutdown both route here.
export function deleteFigures(): string {
  return '\x1b_Ga=d,d=A,q=2\x1b\\'
}

// Device pixels per terminal cell, from the renderer's own capability query
// (kitty-graphics terminals answer the window-pixel report OpenTUI sends at
// startup). A terminal that never answered gets null and the caller's fallback.
export function cellSizeFrom(
  resolution: PixelResolution | null,
  cols: number,
  rows: number,
): { width: number; height: number } | null {
  if (resolution === null || cols <= 0 || rows <= 0) return null
  const width = Math.floor(resolution.width / cols)
  const height = Math.floor(resolution.height / rows)
  if (width <= 0 || height <= 0) return null
  return { width, height }
}
