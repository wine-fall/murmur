import { describe, expect, it } from 'vitest'

import {
  PROTOCOL,
  decodeEngineMessage,
  decodeTuiMessage,
  encode,
  ndjson,
  type EngineMessage,
  type TuiMessage,
} from '../src/host/ipc.ts'

// Every message in the spec-10 §2.3 table, once each: the wire contract is
// pinned by round-tripping the whole set, not a sample.
const ENGINE_MESSAGES: EngineMessage[] = [
  { v: 1, type: 'hello', protocol: PROTOCOL, persona: 'a night host', brain: 'claude', voice: 'hosted' },
  { v: 1, type: 'hello', protocol: PROTOCOL, persona: 'a night host', brain: 'claude', voice: 'hosted', away: 21_600 },
  { v: 1, type: 'hello', protocol: PROTOCOL, persona: 'a night host', brain: 'claude', voice: 'hosted', mode: 'guide' },
  { v: 1, type: 'hello', protocol: PROTOCOL, persona: 'a night host', brain: 'claude', voice: 'hosted', mode: 'report' },
  { v: 1, type: 'segment', text: 'still here, still awake.' },
  { v: 1, type: 'userLine', text: 'me too' },
  { v: 1, type: 'state', state: { kind: 'music', nowPlaying: 'a song', scene: 'late-night', activity: 'engaged' } },
  { v: 1, type: 'state', state: { kind: 'gap' } },
  { v: 1, type: 'state', state: { kind: 'talk' }, microcopy: 'on the air' },
  { v: 1, type: 'info', text: 'now playing: a song' },
  { v: 1, type: 'info', text: 'stopped — the setup guide is waiting for you', tone: 'flow' },
  { v: 1, type: 'ask', text: 'what should I call you?', kind: 'question' },
  { v: 1, type: 'ask', text: 'allow? [y/N]', kind: 'consent' },
  // `back` says /back is live for this step (spec 06 §3.4): the card shows it.
  { v: 1, type: 'ask', text: 'what do you want from the radio?', kind: 'question', back: true },
  { v: 1, type: 'ask', text: 'may I read your history? [y/N]', kind: 'consent', back: true },
  // `step` is the engine's own place in a numbered run (spec 10 §3.2-B): the
  // card titles itself `2/3`. 1-based, and a re-asked step carries its own
  // number again.
  { v: 1, type: 'ask', text: 'what should I call you?', kind: 'question', step: { at: 1, of: 3 } },
  // A question with rows to tick (spec 10 §3.2-D, the /sources list): the
  // answer is still a `line` — the ticked keys, space-joined.
  {
    v: 1,
    type: 'ask',
    text: 'which accounts should I read?\n>> 1) [x] NetEase - 312 liked',
    kind: 'question',
    options: [
      { key: 'netease', label: 'NetEase', note: '312 liked', checked: true },
      { key: 'spotify', label: 'Spotify' },
      // An action row (spec 10 §3.2-D): a button, not a state to tick.
      { key: 'refresh', label: 'refresh now', note: 're-read every connected account now', action: true },
    ],
    multi: true,
  },
  { v: 1, type: 'askDrop' },
  // A notice (spec 10 §3.2-E): shown, answered by nobody. Sending it again
  // replaces what is up; an empty body closes it.
  {
    v: 1,
    type: 'notice',
    title: '2/3 Bilibili — scan with the Bilibili app',
    body: ['█▀▀▀▀▀█', '█ ███ █'],
    footer: 'waiting for the scan · esc - cancel',
  },
  { v: 1, type: 'notice', title: '2/3 Bilibili — scan with the Bilibili app', body: [] },
  // The startup notify bubble (spec 10 §3.7.5): `hint` is optional.
  { v: 1, type: 'bubble', id: 'n1', text: 'a new murmur is out', hint: 'type /update' },
  { v: 1, type: 'bubble', id: 'n2', text: 'still here' },
  { v: 1, type: 'mode', who: 'guide' },
  { v: 1, type: 'mode', who: 'report' },
  { v: 1, type: 'mode', who: 'radio' },
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
      rwtEnabled: true,
      playOrder: ['youtube', 'bilibili', 'qqmusic', 'netease'],
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
      rwtEnabled: true,
      playOrder: ['youtube', 'bilibili', 'qqmusic', 'netease'],
    },
    home: '/tmp/m',
    voiceConfigured: false,
    musicAvailable: false,
    open: true,
  },
  // The current invitation set (spec 14 §2.7): replaces the previous one.
  { v: 1, type: 'invitations', rows: [{ command: '/sources', why: 'your likes make better picks' }] },
  { v: 1, type: 'invitations', rows: [] },
  {
    v: 1,
    type: 'settings',
    values: {
      anchorsEnabled: true,
      musicEnabled: true,
      cadenceMode: 'every_n',
      musicEveryN: 2,
      gapSeconds: 2,
      recentWindow: 12,
      muted: false,
      tuiPet: true,
      rwtEnabled: true,
      playOrder: ['youtube', 'bilibili', 'qqmusic', 'netease'],
    },
    home: '/home/someone/.murmur',
    voiceConfigured: true,
    musicAvailable: true,
    // One read-only line per mounted source (spec 14 §3.1): a fact, never a token.
    sources: [
      { id: 'netease', name: 'NetEase', status: 'ok', refreshed: '2026-09-06T10:00:00.000Z' },
      { id: 'spotify', name: 'Spotify', status: 'expired' },
    ],
  },
  { v: 1, type: 'bye' },
]

const TUI_MESSAGES: TuiMessage[] = [
  { v: 1, type: 'attach', protocol: PROTOCOL },
  { v: 1, type: 'line', text: '/quit' },
  { v: 1, type: 'interrupt' },
  { v: 1, type: 'dismiss', id: 'n1' },
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
    expect(decodeEngineMessage(JSON.stringify({ v: 1, type: 'notice', title: 'x' }))).toBeNull()
    expect(decodeEngineMessage(JSON.stringify({ v: 1, type: 'notice', title: 'x', body: 'y' }))).toBeNull()
  })

  it('rejects an ask step that is not a 1-based place in a run', () => {
    const ask = { v: 1, type: 'ask', text: 'who is listening?', kind: 'question' }
    expect(decodeEngineMessage(JSON.stringify({ ...ask, step: { at: 0, of: 3 } }))).toBeNull()
    expect(decodeEngineMessage(JSON.stringify({ ...ask, step: { at: 1.5, of: 3 } }))).toBeNull()
    expect(decodeEngineMessage(JSON.stringify({ ...ask, step: { at: 1 } }))).toBeNull()
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
