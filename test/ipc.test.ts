import { describe, expect, it } from 'vitest'

import {
  PROTOCOL,
  decodeEngineMessage,
  decodeTuiMessage,
  encode,
  ndjson,
  type EngineMessage,
  type TuiMessage,
} from '../src/ipc.ts'

// Every message in the spec-10 §2.3 table, once each: the wire contract is
// pinned by round-tripping the whole set, not a sample.
const ENGINE_MESSAGES: EngineMessage[] = [
  { v: 1, type: 'hello', protocol: PROTOCOL, persona: 'a night host', brain: 'claude', voice: 'hosted' },
  { v: 1, type: 'hello', protocol: PROTOCOL, persona: 'a night host', brain: 'claude', voice: 'hosted', away: 21_600 },
  { v: 1, type: 'segment', text: 'still here, still awake.' },
  { v: 1, type: 'userLine', text: 'me too' },
  { v: 1, type: 'state', state: { kind: 'music', nowPlaying: 'a song', scene: 'late-night', activity: 'engaged' } },
  { v: 1, type: 'state', state: { kind: 'gap' } },
  { v: 1, type: 'state', state: { kind: 'talk' }, microcopy: 'on the air' },
  { v: 1, type: 'info', text: 'now playing: a song' },
  { v: 1, type: 'ask', text: 'what should I call you?', kind: 'question' },
  { v: 1, type: 'ask', text: 'allow? [y/N]', kind: 'consent' },
  { v: 1, type: 'askDrop' },
  { v: 1, type: 'viz', bins: [0, 0.5, 1] },
  {
    v: 1,
    type: 'settings',
    values: {
      anchorsEnabled: true,
      musicEnabled: false,
      cadenceMode: 'every_n',
      musicEveryN: 2,
      gapSeconds: 2,
      recentWindow: 12,
      muted: true,
      tuiPet: true,
    },
    home: '/home/someone/.murmur',
    voiceConfigured: true,
    musicAvailable: true,
  },
  {
    v: 1,
    type: 'settings',
    values: {
      anchorsEnabled: true,
      musicEnabled: true,
      cadenceMode: 'random',
      musicEveryN: 4,
      gapSeconds: 0,
      recentWindow: 4,
      muted: false,
      tuiPet: false,
    },
    home: '/tmp/m',
    voiceConfigured: false,
    musicAvailable: false,
    open: true,
  },
  { v: 1, type: 'bye' },
]

const TUI_MESSAGES: TuiMessage[] = [
  { v: 1, type: 'attach', protocol: PROTOCOL },
  { v: 1, type: 'line', text: '/quit' },
  { v: 1, type: 'interrupt' },
  { v: 1, type: 'vizSub', on: true, fps: 24 },
  { v: 1, type: 'vizSub', on: false },
  { v: 1, type: 'settingsSet', patch: { musicEnabled: false, gapSeconds: 3.5 } },
  { v: 1, type: 'settingsSet', patch: { muted: true } },
  { v: 1, type: 'settingsSet', patch: { muted: false } },
]

describe('the wire protocol (spec 10 §2.3)', () => {
  it('round-trips every engine -> tui message', () => {
    for (const message of ENGINE_MESSAGES) {
      expect(decodeEngineMessage(encode(message).trimEnd())).toEqual(message)
    }
  })

  it('round-trips every tui -> engine message', () => {
    for (const message of TUI_MESSAGES) {
      expect(decodeTuiMessage(encode(message).trimEnd())).toEqual(message)
    }
  })

  it('encodes one ndjson line per message', () => {
    const line = encode({ v: 1, type: 'bye' })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trimEnd().includes('\n')).toBe(false)
  })

  it('drops unknown types (forward compatibility) and malformed input', () => {
    expect(decodeEngineMessage(JSON.stringify({ v: 1, type: 'sparkle', hue: 3 }))).toBeNull()
    expect(decodeTuiMessage(JSON.stringify({ v: 1, type: 'sparkle' }))).toBeNull()
    expect(decodeEngineMessage('{not json')).toBeNull()
    expect(decodeEngineMessage('')).toBeNull()
    expect(decodeEngineMessage('null')).toBeNull()
    // A known type with a payload that does not validate is dropped, not coerced.
    expect(decodeEngineMessage(JSON.stringify({ v: 1, type: 'segment' }))).toBeNull()
    expect(decodeTuiMessage(JSON.stringify({ v: 1, type: 'line', text: 7 }))).toBeNull()
  })

  it('rejects a foreign envelope version', () => {
    expect(decodeEngineMessage(JSON.stringify({ v: 2, type: 'bye' }))).toBeNull()
  })

  it('a settings patch with an illegal value is a malformed message (spec 12 §2.5)', () => {
    expect(
      decodeTuiMessage(JSON.stringify({ v: 1, type: 'settingsSet', patch: { gapSeconds: -1 } })),
    ).toBeNull()
    expect(
      decodeTuiMessage(JSON.stringify({ v: 1, type: 'settingsSet', patch: { muted: 'yes' } })),
    ).toBeNull()
  })

  it('does not confuse the two directions', () => {
    expect(decodeEngineMessage(encode({ v: 1, type: 'line', text: 'hi' }).trimEnd())).toBeNull()
    expect(decodeTuiMessage(encode({ v: 1, type: 'bye' }).trimEnd())).toBeNull()
  })
})

describe('ndjson framing', () => {
  it('reassembles messages split across chunks', () => {
    const lines: string[] = []
    const feed = ndjson((line) => lines.push(line))
    feed('{"a":1}\n{"b":')
    expect(lines).toEqual(['{"a":1}'])
    feed('2}\n')
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('ignores blank lines and holds an unterminated tail', () => {
    const lines: string[] = []
    const feed = ndjson((line) => lines.push(line))
    feed('\n\nx\ny')
    expect(lines).toEqual(['x'])
  })

  it('drops a pathologically long line instead of buffering forever', () => {
    // Trust boundary: a peer that never sends a newline must not grow the
    // engine's heap without bound.
    const lines: string[] = []
    const feed = ndjson((line) => lines.push(line), { maxLineBytes: 16 })
    feed('x'.repeat(64))
    feed('\nafter\n')
    expect(lines).toEqual(['after'])
  })
})
