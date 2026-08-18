// The spotlight card's pure logic (spec 10 §3.2-B as built): the title names
// the kind of answer (with a light question counter), each card line carries a
// role the renderer colors by, and outbound() decides what a submitted line
// becomes. Rendering itself stays untested (spec 10 §3.9).

import { describe, expect, it } from 'vitest'

import { COMMANDS } from '../src/ipc.ts'
import {
  cardLines,
  cardRows,
  cardTitle,
  cardTopRow,
  commandMatches,
  isCommand,
  outbound,
} from '../tui/src/dock.ts'

describe('outbound', () => {
  it('forwards the empty line while a question is docked — Enter IS the skip (spec 06 §2.1)', () => {
    expect(outbound('', true)).toBe('')
    expect(outbound('   ', true)).toBe('   ')
  })

  it('keeps dropping empty lines when nothing is asked (idle Enter is not a message)', () => {
    expect(outbound('', false)).toBeNull()
    expect(outbound('   ', false)).toBeNull()
    expect(outbound('hello', false)).toBe('hello')
  })
})

describe('commandMatches', () => {
  it('a bare slash opens the menu on every command the engine parses, blurbs riding along', () => {
    expect(commandMatches('/')).toEqual(COMMANDS)
    for (const command of commandMatches('/')) expect(command.blurb.length).toBeGreaterThan(0)
  })

  it('a typed prefix narrows the menu to what the line could still become', () => {
    expect(commandMatches('/q').map((c) => c.name)).toEqual(['/quit'])
    expect(commandMatches('/s').map((c) => c.name)).toEqual(['/settings'])
  })

  it('ordinary talk-back opens no menu — the affordance never crowds a sentence', () => {
    expect(commandMatches('')).toEqual([])
    expect(commandMatches('hello there')).toEqual([])
    expect(commandMatches('what /quit does')).toEqual([])
  })

  it('a slash line no command starts with goes quiet rather than shouting a menu', () => {
    expect(commandMatches('/nope')).toEqual([])
  })

  it('an exact command closes the menu — the ink change carries the confirmation', () => {
    expect(commandMatches('/quit')).toEqual([])
    expect(commandMatches('/settings')).toEqual([])
  })

  it('Tab-completing ANY highlighted command lands on that chain: menu closed, ink warmed', () => {
    // Tab writes the highlighted name into the line verbatim (app.tsx); the
    // menu must then read it as settled for every command the engine parses.
    for (const command of COMMANDS) {
      expect(commandMatches(command.name)).toEqual([])
      expect(isCommand(command.name)).toBe(true)
    }
  })
})

describe('isCommand', () => {
  it('recognizes exactly the engine-parsed commands, whitespace-tolerant', () => {
    expect(isCommand('/quit')).toBe(true)
    expect(isCommand('  /settings  ')).toBe(true)
    expect(isCommand('/q')).toBe(false)
    expect(isCommand('/quit now')).toBe(false)
    expect(isCommand('quit')).toBe(false)
  })
})

describe('the command list', () => {
  it('leads with the harmless command: a stray Enter on the fresh menu opens settings, never quits', () => {
    expect(COMMANDS[0]!.name).toBe('/settings')
  })
})

describe('cardTitle', () => {
  it('names the kind, and counts the questions so a run of them reads as progress', () => {
    expect(cardTitle('question', 3, false)).toBe(' murmur is asking · #3 ')
    expect(cardTitle('consent', 5, false)).toBe(' murmur needs a yes · optional ')
  })

  it('a card carrying the checklist is the pre-broadcast check, whatever its kind', () => {
    expect(cardTitle('consent', 1, true)).toBe(' pre-broadcast check ')
  })
})

describe('cardLines', () => {
  it('the first line is the main sentence; later plain lines are notes', () => {
    expect(cardLines('who is listening?\nanswer in one line.')).toEqual([
      { text: 'who is listening?', role: 'main' },
      { text: 'answer in one line.', role: 'note' },
    ])
  })

  it('splits the opening line at its first question mark — lead bright, detail quiet (ref B1)', () => {
    expect(cardLines('How do you like to be talked to? Dry, warm, or quiet?')).toEqual([
      { text: 'How do you like to be talked to?', role: 'main' },
      { text: 'Dry, warm, or quiet?', role: 'note' },
    ])
  })

  it('a one-sentence question stays whole', () => {
    expect(cardLines('what should I call you?')).toEqual([
      { text: 'what should I call you?', role: 'main' },
    ])
  })

  it("'>> ' rows are options — one per line, marker dropped (user report: the run-on action row)", () => {
    const lines = cardLines('summary.\n-- voice - silent\n>> y - fix them now\n>> Enter - not now')
    expect(lines.at(-2)).toEqual({ text: 'y - fix them now', role: 'option' })
    expect(lines.at(-1)).toEqual({ text: 'Enter - not now', role: 'option' })
  })

  it('checklist rows keep their marker roles, and the closing invite reads bright', () => {
    const lines = cardLines("summary.\nok brain - on the air\n-- voice - silent\ntype 'y':")
    expect(lines.map((l) => l.role)).toEqual(['main', 'ready', 'gap', 'main'])
    // The ASCII markers are role carriers, not copy — the renderer drops them.
    expect(lines[1]!.text).toBe('brain - on the air')
    expect(lines[2]!.text).toBe('voice - silent')
  })

  it('blank lines vanish instead of rendering empty card rows', () => {
    expect(cardLines('a\n\nb').map((l) => l.text)).toEqual(['a', 'b'])
  })
})

// Where the card stands, for the raster layer: a kitty image sits ABOVE text
// cells, so while the card is up the sky's images keep the stage (dimmed)
// only where the card cannot reach. This is the renderer's own width/height
// math replayed as a number.
describe('cardRows / cardTopRow', () => {
  const CONSENT =
    'setup assistant wants to run [Bash]: brew outdated yt-dlp; echo "---"\nallow? [y/N]'

  it('counts content, chrome, and the in-card answer field', () => {
    // 2 unwrapped content rows + action row (2) + answer field (2)
    // + border and padding (4) + the bottom margin (1).
    expect(cardRows(CONSENT, 200)).toBe(11)
  })

  it('wrapped lines take their real height, so a long command still clears the card', () => {
    const long = `setup assistant wants to run [Bash]: ${'x'.repeat(300)}\nallow? [y/N]`
    expect(cardRows(long, 120)).toBeGreaterThan(cardRows(CONSENT, 120))
  })

  it('a checklist card adds its divider row; option rows replace the action row', () => {
    const checklist =
      'summary.\nok brain - on the air\n-- voice - silent\n>> y - fix them now\n>> Enter - not now'
    // 5 content rows (options included) + the divider + field (2) + chrome (4)
    // + margin (1) — a checklist card carries no separate action row.
    expect(cardRows(checklist, 200)).toBe(13)
  })

  it('cardTopRow anchors the card above the bottom row, and never above the screen', () => {
    expect(cardTopRow(CONSENT, 200, 50)).toBe(50 - 1 - cardRows(CONSENT, 200))
    expect(cardTopRow(CONSENT, 200, 8)).toBe(1)
  })
})
