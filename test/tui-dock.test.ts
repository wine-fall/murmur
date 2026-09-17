// The spotlight card's pure logic (spec 10 §3.2-B as built): the title names
// the kind of answer (and the engine step, when the ask has one), each card
// line carries a role the renderer colors by, and outbound() decides what a
// submitted line becomes. Rendering itself stays untested (spec 10 §3.9).

import { describe, expect, it } from 'vitest'

import { COMMANDS, type AskOption } from '../src/host/ipc.ts'
import {
  BACK_CMD,
  BACK_HINT,
  BACK_WHY,
  cardLines,
  cardShape,
  foldLabel,
  wrapRows,
  actionRow,
  CONSENT_ACTIONS,
  backInline,
  cardRows,
  cardTitle,
  cardTopRow,
  commandMatches,
  menuIsOpen,
  NOTICE_CANCEL,
  noticeBody,
  noticeFooter,
  noticeRows,
  noticeShortfall,
  noticeTopRow,
  noticeWidth,
  HINT_ROTATE_MS,
  inputHints,
  heldAwayFromTail,
  isCommand,
  logScrollDelta,
  outbound,
  PAGE_OVERLAP,
  pageStep,
  pickAnswer,
  pickMove,
  listRow,
  listRows,
  APPLY_KEY,
  APPLY_NOTHING,
  pickStart,
  pickToggle,
  visibleLogRows,
  Z_MENU,
  Z_NOTICE,
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
    expect(inputHints([])).toEqual(['type to talk back · / for commands · scroll or PgUp/PgDn'])
    const hints = inputHints([
      { command: '/sources', why: 'your NetEase or Spotify likes make better picks' },
      { command: '/bug', why: "something broke? two lines and it's filed" },
    ])
    // Command first: a narrow field clips the tail, and the command is the
    // half worth keeping (codex review).
    expect(hints).toEqual([
      'type to talk back · / for commands · scroll or PgUp/PgDn',
      '/sources · your NetEase or Spotify likes make better picks',
      "/bug · something broke? two lines and it's filed",
    ])
  })

  it('rotates on a lap of minutes, not seconds — a blinking prompt is noise', () => {
    expect(HINT_ROTATE_MS).toBeGreaterThanOrEqual(60_000)
  })
})

describe('cardTitle', () => {
  it('names the kind, and numbers a question the engine placed in a run', () => {
    expect(cardTitle('question', { at: 2, of: 3 }, 'what do you listen to on a slow morning?')).toBe(
      ' murmur is asking · 2/3 ',
    )
    expect(cardTitle('consent', { at: 1, of: 3 }, 'run brew outdated? [y/N]')).toBe(' murmur needs a yes · optional ')
  })

  it('a question with no place in a run carries no number', () => {
    // The /sources sign-in wait and every one-off ask: a number there was
    // meaningless, and a client-side counter invented one.
    expect(cardTitle('question', undefined, 'press Enter when you have signed in')).toBe(' murmur is asking ')
  })

  it('a card carrying the checklist is the pre-broadcast check, whatever its kind', () => {
    expect(cardTitle('consent', undefined, 'summary.\nok brain - on\n-- voice - off\n>> y - fix')).toBe(
      ' pre-broadcast check ',
    )
  })

  it('a menu — a question with option rows — carries no counter: it is not a step in a run', () => {
    const menu = 'what would you like to do? mount <name> | done\n>> mount netease - NetEase'
    expect(cardTitle('question', undefined, menu)).toBe(' murmur is asking ')
    const withMounted = 'what would you like to do? mount <name> | done\nok YouTube - 1 liked\n>> mount netease - NetEase'
    expect(cardTitle('question', undefined, withMounted)).toBe(' murmur is asking ')
    // Everything mounted leaves no option row; the status rows still make it
    // a menu, never the pre-broadcast check (codex review).
    const allMounted = 'what would you like to do? mount <name> | done\nok YouTube - 1 liked\n-- NetEase - expired'
    expect(cardTitle('question', undefined, allMounted)).toBe(' murmur is asking ')
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

  // The /sources sign-in card leads with what the submit already did (spec 14
  // §3.1), so the question is no longer the card's first line — and a card
  // whose only question renders as a dim note inverts its own hierarchy.
  it('the question is the main line even when result rows lead the card', () => {
    const lines = cardLines('ok connected YouTube — signed in as Zach G · 312 liked\nHow should I sign in to NetEase?\nsigned in to the wrong account there?\n>> 1) [x] scan with the NetEase Cloud Music app')
    expect(lines.map((l) => l.role)).toEqual(['ready', 'main', 'note', 'option'])
  })

  it('blank lines vanish instead of rendering empty card rows', () => {
    expect(cardLines('a\n\nb').map((l) => l.text)).toEqual(['a', 'b'])
  })
})

// Where the card stands, for the raster layer: a kitty image sits ABOVE text
// cells, so while the card is up the sky's images keep the stage (dimmed)
// only where the card cannot reach. This is the renderer's own width/height
// math replayed as a number.
// The card floats at the bottom with a content-sized height, and nothing
// clamped it: a card taller than the terminal lost its TOP rows — the border,
// the title, and the result rows the sign-in card leads with. Measured at
// 80x24 under the pty harness before the fix (issue #264). The cut is now
// made here, in the card's own geometry, in a fixed order: notes fold away
// first, then the results; the question, the answer rows and the action row
// are never sacrificed.
describe('fitCard (issue #264)', () => {
  const OBSTACLE =
    '-- could not connect YouTube — Chrome is here, but I am not allowed to read its cookie store — give this terminal Full Disk Access (System Settings → Privacy & Security), then /sources again.'
  const TIMED_OUT = '-- could not connect Bilibili, QQ Music — the code timed out — /sources to get a fresh one.'
  const SIGN_IN = [
    OBSTACLE,
    TIMED_OUT,
    'How should I sign in to NetEase?',
    'signed in to the wrong account there? sign out on the site in that Chrome window, then pick it again.',
    '>> 1) [x] scan with the NetEase Cloud Music app',
    '>> 2) [ ] Chrome — Work (zach.guo@opus.pro)',
    '>> 3) [ ] Chrome — Personal (fawinell@gmail.com)',
  ].join('\n')
  const SIGN_IN_OPTIONS: AskOption[] = [
    { key: 'scan', label: 'scan with the NetEase Cloud Music app', checked: true },
    { key: 'chrome:Default', label: 'Chrome — Work (zach.guo@opus.pro)' },
    { key: 'chrome:Profile 3', label: 'Chrome — Personal (fawinell@gmail.com)' },
  ]
  const MENU = [
    'which accounts should I read? Enter with nothing changed leaves',
    OBSTACLE,
    TIMED_OUT,
  ].join('\n')
  const MENU_OPTIONS: AskOption[] = ['YouTube', 'Bilibili', 'NetEase', 'Spotify', 'Soda Music', 'QQ Music'].map((label) => ({
    key: label,
    label,
    note: 'not connected',
  }))

  // The renderer word-wraps; counting ceil(length / inner) under-counts every
  // line that cannot break on a column boundary, which is how a card that had
  // just been fitted still drew one row past the top. These four numbers are
  // read off the real 80x24 frame (pty harness, inner 38).
  it('measures a line the way the renderer wraps it — on words, not on columns', () => {
    expect(wrapRows(`--  ${OBSTACLE.slice(3)}`, 38)).toBe(6)
    expect(wrapRows(`--  ${TIMED_OUT.slice(3)}`, 38)).toBe(3)
    expect(wrapRows('How should I sign in to NetEase?', 38)).toBe(1)
    expect(wrapRows('signed in to the wrong account there? sign out on the site in that Chrome window, then pick it again.', 38)).toBe(3)
    // A word longer than the card still breaks mid-word rather than running off it.
    expect(wrapRows('x'.repeat(100), 38)).toBe(3)
  })

  it('the sign-in card fits an 80x24 terminal — the case measured at 27 rows', () => {
    expect(cardRows(SIGN_IN, 80, 'question', SIGN_IN_OPTIONS, false, false)).toBeGreaterThan(24)
    expect(cardRows(SIGN_IN, 80, 'question', SIGN_IN_OPTIONS, false, false, 24)).toBeLessThanOrEqual(24)
  })

  it('the /sources menu card fits too — the overflow it carried before the sign-in card existed', () => {
    expect(cardRows(MENU, 80, 'question', MENU_OPTIONS, false, true)).toBeGreaterThan(24)
    expect(cardRows(MENU, 80, 'question', MENU_OPTIONS, false, true, 24)).toBeLessThanOrEqual(24)
  })

  // The smallest honest card is its frame, its question, one row to answer
  // with and the counters for the rows out of view; a terminal shorter than
  // that has no card to show. Everything at or above it fits, at every height.
  it('fits every terminal height that can hold the smallest honest card', () => {
    for (const [text, options, multi] of [
      [SIGN_IN, SIGN_IN_OPTIONS, false],
      [MENU, MENU_OPTIONS, true],
    ] as const) {
      const floor = cardRows(text, 80, 'question', options, false, multi, 1)
      expect(floor).toBeLessThanOrEqual(14)
      for (let height = floor; height <= 60; height++) {
        expect(cardRows(text, 80, 'question', options, false, multi, height)).toBeLessThanOrEqual(height)
      }
    }
  })

  it('folds the notes first: the question and every option row stay', () => {
    const fit = cardShape({ text: SIGN_IN, cols: 80, height: 24, kind: 'question', options: SIGN_IN_OPTIONS })
    expect(fit.lines.some((l) => l.role === 'note')).toBe(false)
    expect(fit.lines.find((l) => l.role === 'main')?.text).toBe('How should I sign in to NetEase?')
    // Nothing was cut from the answer: all three roads are still on the card.
    expect([fit.from, fit.to]).toEqual([0, 3])
    // The results survived this one — only the note had to go.
    expect(fit.lines.filter((l) => l.role === 'gap')).toHaveLength(2)
  })

  it('folds the results next, and says how many it folded rather than dropping them silently', () => {
    const fit = cardShape({ text: MENU, cols: 80, height: 24, kind: 'question', options: MENU_OPTIONS, multi: true })
    expect(fit.lines.find((l) => l.role === 'main')?.text).toBe('which accounts should I read?')
    expect(fit.folded).toBeGreaterThan(0)
    expect(fit.lines.some((l) => l.text === foldLabel(fit.folded))).toBe(true)
    // Every row that can be ticked is still there — the answer is never folded.
    expect([fit.from, fit.to]).toEqual([0, MENU_OPTIONS.length + 1])
  })

  it('windows the option rows around the cursor when the rows alone cannot fit, and never hides the row being answered', () => {
    const many: AskOption[] = Array.from({ length: 30 }, (_, i) => ({ key: `k${String(i)}`, label: `source ${String(i)}` }))
    const fit = cardShape({ text: 'which accounts should I read?', cols: 80, height: 20, kind: 'question', options: many, at: 22 })
    expect(fit.to - fit.from).toBeLessThan(30)
    expect(fit.from).toBeLessThanOrEqual(22)
    expect(fit.to).toBeGreaterThan(22)
    // What is off the window is counted, not silently gone.
    expect(fit.above).toBe(fit.from)
    expect(fit.below).toBe(30 - fit.to)
    expect(cardRows('which accounts should I read?', 80, 'question', many, false, false, 20)).toBeLessThanOrEqual(20)
  })

  it('leaves a card that already fits exactly as it was', () => {
    const seed = 'what do you want from the radio?'
    expect(cardRows(seed, 120, 'question', undefined, false, false, 40)).toBe(cardRows(seed, 120, 'question'))
    const fit = cardShape({ text: SIGN_IN, cols: 80, height: 60, kind: 'question', options: SIGN_IN_OPTIONS })
    expect(fit.folded).toBe(0)
    expect(fit.lines.some((l) => l.role === 'note')).toBe(true)
  })
})

describe('cardRows / cardTopRow', () => {
  const CONSENT =
    'setup assistant wants to run [Bash]: brew outdated yt-dlp; echo "---"\nallow? [y/N]'

  it('counts content, chrome, and the in-card answer field', () => {
    // 2 unwrapped content rows + action row (2) + answer field (2)
    // + border and padding (4) + the two rows it floats above (2).
    expect(cardRows(CONSENT, 200, 'consent')).toBe(12)
  })

  it('wrapped lines take their real height, so a long command still clears the card', () => {
    const long = `setup assistant wants to run [Bash]: ${'x'.repeat(300)}\nallow? [y/N]`
    expect(cardRows(long, 120, 'consent')).toBeGreaterThan(cardRows(CONSENT, 120, 'consent'))
  })

  it('the consent row offers two peers — no cursor, no chip, nothing pre-chosen', () => {
    // The reported misread (2026-09-15): the default drawn as '> N - not now'
    // on a CHIP is the exact treatment the list card gives THE ROW YOU ARE ON,
    // so the card looked answered before it was answered. The two keys read as
    // equals now; which one Enter means is said in words, not in highlight.
    const row = CONSENT_ACTIONS.join('')
    expect(row).toBe('y - go ahead   ·   Enter - not now')
    expect(row).not.toContain('>')
    expect(actionRow('consent', [], undefined, false)).toBe(row)
  })

  it('the /back hint is a command plus its why, so the renderer can light the command alone', () => {
    expect(BACK_CMD).toBe('/back')
    expect(BACK_CMD + BACK_WHY).toBe(BACK_HINT)
  })

  it('the /back hint shares the action row where it fits, and takes the row beneath where it would wrap', () => {
    // The consent row joined with the hint is 62 columns: one row on a wide
    // card, its own row on a 120-column one (inner 60) and on an 80-column
    // one (inner 38, the consent row alone).
    expect(actionRow('consent', [], undefined, true)).toHaveLength(62)
    expect(backInline('consent', [], undefined, 62)).toBe(true)
    expect(backInline('consent', [], undefined, 61)).toBe(false)
    expect(backInline('consent', [], undefined, 60)).toBe(false)
    // A 128-column terminal's card is 64 inner columns — the peer row fits
    // there with the hint beside it, where the old chip row did not.
    expect(cardRows(CONSENT, 128, 'consent', undefined, true)).toBe(cardRows(CONSENT, 128, 'consent'))
    expect(cardRows(CONSENT, 200, 'consent', undefined, true)).toBe(12)
    expect(cardRows(CONSENT, 120, 'consent', undefined, true)).toBe(cardRows(CONSENT, 120, 'consent') + 1)
    expect(cardRows(CONSENT, 80, 'consent', undefined, true)).toBe(cardRows(CONSENT, 80, 'consent') + 1)
    // The seed row, 39 columns with the hint joined: one row at
    // 120, its own row at 80.
    const seed = 'what do you want from the radio?'
    expect(cardRows(seed, 120, 'question', undefined, true)).toBe(cardRows(seed, 120, 'question'))
    expect(cardRows(seed, 80, 'question', undefined, true)).toBe(cardRows(seed, 80, 'question') + 1)
  })

  it('a checklist card adds its divider row; option rows replace the action row', () => {
    const checklist =
      'summary.\nok brain - on the air\n-- voice - silent\n>> y - fix them now\n>> Enter - not now'
    // 5 content rows (options included) + the divider + field (2) + chrome (4)
    // + the inset (2) — a checklist card carries no separate action row.
    expect(cardRows(checklist, 200, 'consent')).toBe(14)
  })

  it('a question menu keeps its action row even above status rows — only a consent checklist drops it', () => {
    const menu = 'what would you like to do? mount <name> | done\nok YouTube - 1 liked\n>> mount netease - NetEase'
    // 4 content rows (the lead splits at '? ') + divider + action row (2)
    // + field (2) + chrome (4) + margin (1).
    expect(cardRows(menu, 200, 'question')).toBe(15)
    expect(cardRows(menu, 200, 'consent')).toBe(13)
  })

  it('a list card stands on its rows, not the text\'s >> lines, and has no answer field', () => {
    const text = 'which accounts should I read?\n>> 1) [x] NetEase - 312 liked\n>> 2) [ ] Spotify - not connected'
    const options = [
      { key: 'netease', label: 'NetEase', note: '312 liked', checked: true },
      { key: 'spotify', label: 'Spotify', note: 'not connected' },
    ]
    // 1 lead row + 2 list rows + action row (2) + chrome (4) + margin (1); no
    // divider (no facts), no field — the list IS the answer.
    expect(cardRows(text, 200, 'question', options)).toBe(11)
    // A multi list also stands on the apply row the client synthesizes.
    expect(cardRows(text, 200, 'question', options, false, true)).toBe(12)
    // A result row above the list brings the divider back.
    expect(cardRows(`which accounts should I read?\nok NetEase - signed in\n${text.split('\n').slice(1).join('\n')}`, 200, 'question', options)).toBe(13)
  })

  it('cardTopRow anchors the card above the bottom row, and never above the screen', () => {
    expect(cardTopRow(CONSENT, 200, 50, 'consent')).toBe(50 - cardRows(CONSENT, 200, 'consent'))
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

describe('logScrollDelta (the wheel and the page keys, spec 10 §3.4)', () => {
  it('reads one wheel notch as one row: alternate-scroll delivers it as an arrow', () => {
    expect(logScrollDelta('up', 30)).toBe(-1)
    expect(logScrollDelta('down', 30)).toBe(1)
  })

  it('reads a page key as a screenful minus the overlap, in the same two directions', () => {
    expect(logScrollDelta('pageup', 30)).toBe(-pageStep(30))
    expect(logScrollDelta('pagedown', 30)).toBe(pageStep(30))
  })

  it('claims no other key — every one of them belongs to someone else', () => {
    for (const key of ['left', 'right', 'return', 'escape', 'space', 'tab']) {
      expect(logScrollDelta(key, 30)).toBeNull()
    }
  })
})

describe('heldAwayFromTail (a manual scroll stops the log trimming its head)', () => {
  it('is false at the tail, where the log is free to drop its oldest entry', () => {
    expect(heldAwayFromTail(80, 20, 100)).toBe(false)
  })

  it('is true one row off the tail — one wheel notch is already reading back', () => {
    // The off-by-one that let a full log trim under a single-notch scroll:
    // the head went, everything under it shifted up, and the reader skipped
    // forward while standing still.
    expect(heldAwayFromTail(79, 20, 100)).toBe(true)
  })

  it('is false when the content is shorter than the viewport', () => {
    expect(heldAwayFromTail(0, 20, 6)).toBe(false)
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
    { key: 'refresh', label: 'refresh now', action: true },
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

  // An action row is a BUTTON, not a state (spec 10 §3.2-D, 2026-09-16): it
  // cannot be ticked, so Space on it never changes the selection — pressing
  // it is a submit, which app.tsx reads off the same flag.
  it('an action row cannot be ticked: Space leaves the selection where it was', () => {
    const onRefresh = pickMove(pickStart(options), 2, options.length)
    expect(pickToggle(onRefresh, options, true)).toEqual(onRefresh)
    expect(pickToggle(onRefresh, options, false)).toEqual(onRefresh)
  })

  // Pressing it submits the ticks AND its key — the same line the flow has
  // always parsed ('netease refresh'), so nothing changes engine-side.
  it('answering from an action row adds that row\'s key to the ticked ones', () => {
    const onRefresh = pickMove(pickStart(options), 2, options.length)
    expect(pickAnswer(onRefresh, options)).toBe('netease refresh')
  })

  // A single-pick list always answers with exactly one row (spec 14 §3.1, the
  // sign-in card): space PICKS the row under the cursor, it never clears the
  // list. Un-ticking left the card with nothing chosen and Enter answering
  // '' — which the flow reads as the preselected row, so the listener got
  // back the very row they had just un-ticked (caught in a rendered frame).
  it('a single-pick list cannot be emptied: space moves the one tick, it never clears it', () => {
    const start = pickStart(options)
    expect(pickToggle(start, options, false).checked).toEqual(['netease'])
    const moved = pickToggle(pickMove(start, 1, options.length), options, false)
    expect(pickToggle(moved, options, false).checked).toEqual(['spotify'])
  })

  it('answers with the ticked keys in row order, space-joined; nothing ticked is the empty line', () => {
    const start = pickStart(options)
    expect(pickAnswer(start, options)).toBe('netease')
    expect(pickAnswer(pickToggle(start, options, true), options)).toBe('')
  })
})

// The submit the card was missing (spec 10 §3.2-D / 14 §3.1, user report):
// the multi card had no button, only a grey footer, so nothing on screen
// said what counted as submitting. The row is the CLIENT's — the engine
// never sees it and must never be answered with its key.
describe('the synthesized apply row', () => {
  const options = [
    { key: 'netease', label: 'NetEase', checked: true },
    { key: 'spotify', label: 'Spotify' },
    { key: 'refresh', label: 'refresh now', action: true },
  ]

  it('closes a multi list and says the card has no changes yet', () => {
    const rows = listRows(options, true, pickStart(options))
    expect(rows).toHaveLength(options.length + 1)
    expect(rows.at(-1)).toEqual({ key: APPLY_KEY, label: 'apply', action: true, note: APPLY_NOTHING })
    expect(APPLY_NOTHING).toBe('nothing changed — Enter leaves')
  })

  it('counts the changes against what stands, ticks and unticks alike', () => {
    const start = pickStart(options)
    const off = pickToggle(start, options, true)
    expect(listRows(options, true, off).at(-1)?.note).toBe('1 change')
    const swapped = pickToggle(pickMove(off, 1, options.length), options, true)
    expect(listRows(options, true, swapped).at(-1)?.note).toBe('2 changes')
  })

  it('never joins a single-pick card, where Enter already means take this row', () => {
    expect(listRows(options, false, pickStart(options))).toEqual(options)
  })

  it('is a cursor stop that answers with the ticks alone — its key stays off the wire', () => {
    const rows = listRows(options, true, pickStart(options))
    const onApply = pickMove(pickStart(options), rows.length - 1, rows.length)
    expect(onApply.at).toBe(3)
    expect(pickAnswer(onApply, rows)).toBe('netease')
    expect(pickToggle(onApply, rows, true)).toEqual(onApply)
  })

  it('draws as a button, while a state row keeps its box', () => {
    expect(listRow({ key: 'refresh', label: 'refresh now', action: true, note: 'now' })).toBe('  ( refresh now )  now')
    expect(listRow({ key: 'netease', label: 'NetEase', checked: true, note: '312 liked' })).toBe('  [x] NetEase  312 liked')
  })
})

// The notice card (spec 10 §3.2-E): a sign-in code, read and not answered.
// Its geometry is exact rather than estimated — the body never wraps.
describe('the notice card', () => {
  const QR = Array.from({ length: 25 }, () => '█'.repeat(49))
  const notice = { v: 1 as const, type: 'notice' as const, title: '2/3 Bilibili — scan with the Bilibili app', body: QR, footer: `waiting for the scan · ${NOTICE_CANCEL}` }

  it('stands on its body, its footer and its frame — nothing wrapped', () => {
    // 25 body rows + the footer and its top margin + border (2) + padding (2).
    expect(noticeRows(QR, notice.footer)).toBe(31)
    expect(noticeRows(QR)).toBe(29)
  })

  it('is cut to its content, so a 49-column code stays scannable and whole', () => {
    // The code's own width plus the border (2) and the padding (4) — the same
    // card on a wide terminal, because a wider one would only add dead space.
    expect(noticeWidth(QR, 80)).toBe(55)
    expect(noticeWidth(QR, 120)).toBe(55)
    // The title is measured with the body: the border spends the same room on it.
    expect(noticeWidth([`${notice.title} and then some more`, ...QR], 120)).toBe(66)
    // And never wider than the terminal it is drawn in.
    expect(noticeWidth(QR, 40)).toBe(36)
  })

  it('floats above the resting input, which a notice never takes', () => {
    // height 40, a one-row input: the gap row, the input, then the card.
    expect(noticeTopRow(notice, 120, 40, 1)).toBe(40 - 1 - 1 - 31)
    expect(noticeTopRow(notice, 120, 10, 1)).toBe(1)
  })

  it('says how far short a small terminal is instead of drawing half a code', () => {
    expect(noticeShortfall(notice, 120, 40, 1)).toEqual({ rows: 0, cols: 0 })
    // 31 rows + the gap row + the input = 33; a 24-row terminal is 9 short.
    expect(noticeShortfall(notice, 120, 24, 1)).toEqual({ rows: 9, cols: 0 })
    expect(noticeBody(notice, 120, 40, 1)).toEqual(QR)
    expect(noticeBody(notice, 120, 24, 1)).toEqual(['this terminal is 9 rows short for the code'])
    expect(noticeBody(notice, 120, 32, 1)).toEqual(['this terminal is 1 row short for the code'])
  })

  // A terminal too NARROW folds the code instead of cutting it off, which is
  // the same unscannable nothing and does not even look broken: the card was
  // drawn full, with a wrapped code in it (codex review).
  it('counts the columns too — a folded code is as unscannable as a cut one', () => {
    // 49 columns + border (2) + padding (4) = 55, and the card may use cols-4.
    expect(noticeShortfall(notice, 59, 40, 1)).toEqual({ rows: 0, cols: 0 })
    expect(noticeShortfall(notice, 55, 40, 1)).toEqual({ rows: 0, cols: 4 })
    expect(noticeBody(notice, 55, 40, 1)).toEqual(['this terminal is 4 columns short for the code'])
    expect(noticeBody(notice, 55, 24, 1)).toEqual(['this terminal is 9 rows and 4 columns short for the code'])
  })

  it('lights the way out like the /back hint: the key, then its quiet why', () => {
    expect(noticeFooter(`waiting for the scan · ${NOTICE_CANCEL}`)).toEqual({ lead: 'waiting for the scan · ', cancel: true })
    expect(noticeFooter('scanned — confirm on your phone')).toEqual({ lead: 'scanned — confirm on your phone', cancel: false })
  })
})

describe('menuIsOpen', () => {
  const up = { hidden: false, pane: false, asks: 0 }

  it('opens on a partial command and closes for everything that outranks it', () => {
    expect(menuIsOpen(3, up)).toBe(true)
    expect(menuIsOpen(0, up)).toBe(false)
    expect(menuIsOpen(3, { ...up, hidden: true })).toBe(false)
    expect(menuIsOpen(3, { ...up, pane: true })).toBe(false)
    expect(menuIsOpen(3, { ...up, asks: 1 })).toBe(false)
  })
})

// The key router's precedence is list card > command menu > notice / log, and
// the z-order has to say the same thing: the menu answers Esc while it is up,
// so it must be the surface the listener can see. A menu left invisible under
// a notice card went on eating Esc while the card printed 'esc - cancel'
// (codex review).
describe('the float z-order (spec 10 §3.2)', () => {
  it('puts the command menu over a notice card, because it is the one taking Esc', () => {
    expect(Z_MENU).toBeGreaterThan(Z_NOTICE)
  })
})
