// The spotlight card's pure logic (spec 10 §3.2-B as built): the title names
// the kind of answer (with a light question counter), each card line carries a
// role the renderer colors by, and outbound() decides what a submitted line
// becomes. Rendering itself stays untested (spec 10 §3.9).

import { describe, expect, it } from 'vitest'

import { COMMANDS } from '../src/host/ipc.ts'
import {
  cardLines,
  cardRows,
  cardTitle,
  cardTopRow,
  commandMatches,
  HINT_ROTATE_MS,
  inputHints,
  isCommand,
  outbound,
  PAGE_OVERLAP,
  pageStep,
  pickAnswer,
  pickMove,
  pickStart,
  pickToggle,
  visibleLogRows,
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
    expect(commandMatches('/s').map((c) => c.name)).toEqual(['/settings', '/sources', '/setup'])
    expect(commandMatches('/setu').map((c) => c.name)).toEqual(['/setup'])
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

// spec 10 §3.2-C: the resting input rotates its invitation so the feedback
// commands are eventually seen without a line ever entering the transcript.
describe('the input hints (spec 14 §3.8)', () => {
  it('rests on the talk-back invitation first, then the engine\'s current rows', () => {
    expect(inputHints([])).toEqual(['type to talk back · / for commands · PgUp/PgDn scrolls'])
    const hints = inputHints([
      { command: '/sources', why: 'your NetEase or Spotify likes make better picks' },
      { command: '/bug', why: "something broke? two lines and it's filed" },
    ])
    // Command first: a narrow field clips the tail, and the command is the
    // half worth keeping (codex review).
    expect(hints).toEqual([
      'type to talk back · / for commands · PgUp/PgDn scrolls',
      '/sources · your NetEase or Spotify likes make better picks',
      "/bug · something broke? two lines and it's filed",
    ])
  })

  it('rotates on a lap of minutes, not seconds — a blinking prompt is noise', () => {
    expect(HINT_ROTATE_MS).toBeGreaterThanOrEqual(60_000)
  })
})

describe('cardTitle', () => {
  it('names the kind, and counts the seed questions so a run of them reads as progress', () => {
    expect(cardTitle('question', 3, 'what do you listen to on a slow morning?')).toBe(' murmur is asking · #3 ')
    expect(cardTitle('consent', 5, 'run brew outdated? [y/N]')).toBe(' murmur needs a yes · optional ')
  })

  it('a card carrying the checklist is the pre-broadcast check, whatever its kind', () => {
    expect(cardTitle('consent', 1, 'summary.\nok brain - on\n-- voice - off\n>> y - fix')).toBe(' pre-broadcast check ')
  })

  it('a menu — a question with option rows — carries no counter: it is not a step in a run', () => {
    const menu = 'what would you like to do? mount <name> | done\n>> mount netease - NetEase'
    expect(cardTitle('question', 4, menu)).toBe(' murmur is asking ')
    const withMounted = 'what would you like to do? mount <name> | done\nok YouTube - 1 liked\n>> mount netease - NetEase'
    expect(cardTitle('question', 4, withMounted)).toBe(' murmur is asking ')
    // Everything mounted leaves no option row; the status rows still make it
    // a menu, never the pre-broadcast check (codex review).
    const allMounted = 'what would you like to do? mount <name> | done\nok YouTube - 1 liked\n-- NetEase - expired'
    expect(cardTitle('question', 4, allMounted)).toBe(' murmur is asking ')
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
    expect(cardRows(CONSENT, 200, 'consent')).toBe(11)
  })

  it('wrapped lines take their real height, so a long command still clears the card', () => {
    const long = `setup assistant wants to run [Bash]: ${'x'.repeat(300)}\nallow? [y/N]`
    expect(cardRows(long, 120, 'consent')).toBeGreaterThan(cardRows(CONSENT, 120, 'consent'))
  })

  it('a checklist card adds its divider row; option rows replace the action row', () => {
    const checklist =
      'summary.\nok brain - on the air\n-- voice - silent\n>> y - fix them now\n>> Enter - not now'
    // 5 content rows (options included) + the divider + field (2) + chrome (4)
    // + margin (1) — a checklist card carries no separate action row.
    expect(cardRows(checklist, 200, 'consent')).toBe(13)
  })

  it('a question menu keeps its action row even above status rows — only a consent checklist drops it', () => {
    const menu = 'what would you like to do? mount <name> | done\nok YouTube - 1 liked\n>> mount netease - NetEase'
    // 4 content rows (the lead splits at '? ') + divider + action row (2)
    // + field (2) + chrome (4) + margin (1).
    expect(cardRows(menu, 200, 'question')).toBe(14)
    expect(cardRows(menu, 200, 'consent')).toBe(12)
  })

  it('a list card stands on its rows, not the text\'s >> lines, and has no answer field', () => {
    const text = 'which accounts should I read?\n>> 1) [x] NetEase - 312 liked\n>> 2) [ ] Spotify - not connected'
    const options = [
      { key: 'netease', label: 'NetEase', note: '312 liked', checked: true },
      { key: 'spotify', label: 'Spotify', note: 'not connected' },
    ]
    // 1 lead row + 2 list rows + action row (2) + chrome (4) + margin (1); no
    // divider (no facts), no field — the list IS the answer.
    expect(cardRows(text, 200, 'question', options)).toBe(10)
    // A result row above the list brings the divider back.
    expect(cardRows(`which accounts should I read?\nok NetEase - signed in\n${text.split('\n').slice(1).join('\n')}`, 200, 'question', options)).toBe(12)
  })

  it('cardTopRow anchors the card above the bottom row, and never above the screen', () => {
    expect(cardTopRow(CONSENT, 200, 50, 'consent')).toBe(50 - 1 - cardRows(CONSENT, 200, 'consent'))
    expect(cardTopRow(CONSENT, 200, 8, 'consent')).toBe(1)
  })
})

describe('pageStep (PageUp/PageDown through the program log)', () => {
  it('moves a screenful minus an overlap, so the eye keeps its place', () => {
    // A full-viewport jump leaves nothing in common between the two screens
    // and the reader has to find their line again.
    expect(pageStep(30)).toBe(30 - PAGE_OVERLAP)
    expect(pageStep(12)).toBe(12 - PAGE_OVERLAP)
  })

  it('never stalls in a short log — a page always moves at least one row', () => {
    // The overlap must not eat the whole step: a key that does nothing reads
    // as a broken key, and the log floor is only six rows to begin with.
    for (const rows of [0, 1, 2, 3]) expect(pageStep(rows)).toBeGreaterThanOrEqual(1)
  })
})

describe('visibleLogRows (an overlay hides rows without taking them)', () => {
  it('is the whole box when nothing is floating over it', () => {
    expect(visibleLogRows(4, 20, null)).toBe(20)
  })

  it('stops at the overlay, so a page never steps past covered rows', () => {
    // Log occupies screen rows 4..24; a card pinned at row 18 hides 18..24.
    expect(visibleLogRows(4, 20, 18)).toBe(14)
  })

  it('ignores an overlay that starts below the log', () => {
    expect(visibleLogRows(4, 20, 30)).toBe(20)
  })

  it('never reports zero, even under an overlay that covers everything', () => {
    // A step of zero rows is a key that does nothing — the failure mode the
    // page floor exists to rule out.
    expect(visibleLogRows(4, 20, 4)).toBe(1)
    expect(visibleLogRows(4, 20, 1)).toBe(1)
  })
})

describe('the list card\'s pick model (spec 10 §3.2-B, rows to tick)', () => {
  const options = [
    { key: 'netease', label: 'NetEase', checked: true },
    { key: 'spotify', label: 'Spotify' },
    { key: 'refresh', label: 'refresh' },
  ]

  it('starts on the first row with the pre-ticked keys ticked', () => {
    expect(pickStart(options)).toEqual({ at: 0, checked: ['netease'] })
  })

  it('moves within the rows and never past either end', () => {
    const start = pickStart(options)
    expect(pickMove(start, -1, options.length).at).toBe(0)
    expect(pickMove(start, 1, options.length).at).toBe(1)
    expect(pickMove(pickMove(start, 1, options.length), 5, options.length).at).toBe(2)
  })

  it('toggles the row under the cursor in a multi list; a single list keeps one', () => {
    const start = pickStart(options)
    expect(pickToggle(start, options, true).checked).toEqual([])
    const second = pickToggle(pickMove(start, 1, options.length), options, true)
    expect(second.checked).toEqual(['netease', 'spotify'])
    expect(pickToggle(pickMove(start, 1, options.length), options, false).checked).toEqual(['spotify'])
  })

  it('answers with the ticked keys in row order, space-joined; nothing ticked is the empty line', () => {
    const start = pickStart(options)
    const both = pickToggle(pickMove(start, 2, options.length), options, true)
    expect(pickAnswer(both, options)).toBe('netease refresh')
    expect(pickAnswer(pickToggle(start, options, true), options)).toBe('')
  })
})
