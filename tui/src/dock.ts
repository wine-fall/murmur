// The spotlight card's pure logic (spec 10 §3.2-B as built): when the engine
// marks a question (`ask` on the wire), the client dims the room and pins the
// queue head in a centered card above the input. This module shapes the card's
// text; app.tsx renders it (wrapping is <text>'s own — no hand-rolled folding).

import { COMMANDS, type AskOption, type EngineMessage, type Invitation } from '../../src/host/ipc.ts'

export type Ask = Extract<EngineMessage, { type: 'ask' }>
export type AskKind = Ask['kind']

// A menu is a question with structured rows — options to pick, or status
// rows to read (/sources with everything mounted has only those). A seed
// question is plain text. Read from the ask text alone: zero wire additions.
export function isMenu(kind: AskKind, lines: readonly CardLine[], options?: readonly AskOption[]): boolean {
  return kind === 'question' && (options !== undefined || lines.some((l) => l.role !== 'main' && l.role !== 'note'))
}

// The border title, padded so the frame breathes around it. A seed question
// carries a light counter — a run of them reads as progress; a menu is not a
// step in a run, so it carries none; a consent names its skippability; a
// card carrying the checklist is the pre-broadcast check (ref B3), whatever
// kind delivered it.
export function cardTitle(kind: AskKind, count: number, text: string, options?: readonly AskOption[]): string {
  const lines = cardLines(text)
  if (isMenu(kind, lines, options)) return ' murmur is asking '
  if (lines.some((l) => l.role === 'ready' || l.role === 'gap')) return ' pre-broadcast check '
  return kind === 'consent'
    ? ' murmur needs a yes · optional '
    : ` murmur is asking · #${String(count)} `
}

// The way back, named on the card when the engine says the step has one
// (spec 06 §3.4): the intro line that mentions /back has scrolled off by the
// second question, so the action row is where it is read. Split in two so the
// renderer can light the command and leave its why quiet — read as one more
// grey phrase, the offer was being missed.
export const BACK_CMD = '/back'
export const BACK_WHY = ' - previous question'
export const BACK_HINT = `${BACK_CMD}${BACK_WHY}`

// The action row's text, as the renderer lays it out: what closes the card
// under the question — a consent's two options, a list's keys, a menu's or a
// seed's Enter — plus the /back hint when the step has one.
// A consent's two options as the renderer lays them out, spacing included —
// measured from the same string it is drawn from, or a boundary width wraps
// the row the math thought fit (codex review). The two are PEERS: a default
// drawn as the row you are on (a cursor on a raised chip) reads as a choice
// already made, so which key Enter is stands in words instead. The odd
// indices are the quiet halves; the even ones are the keys.
export const CONSENT_ACTIONS = ['y', ' - go ahead   ·   ', 'Enter', ' - not now'] as const

export function actionRow(kind: AskKind, lines: readonly CardLine[], options?: readonly AskOption[], back = false): string {
  if (kind === 'consent') return `${CONSENT_ACTIONS.join('')}${back ? `   ${BACK_HINT}` : ''}`
  if (options !== undefined) return '↑↓ move · space ticks · enter applies'
  if (isMenu(kind, lines)) return 'Enter - done'
  return `Enter skips${back ? ` · ${BACK_HINT}` : ''}`
}

// The hint shares the action row when the row fits the card's inner width,
// and takes the row beneath when it would wrap mid-phrase: an 80-column
// card holds 38, which is the consent row alone.
export function backInline(kind: AskKind, lines: readonly CardLine[], options: readonly AskOption[] | undefined, inner: number): boolean {
  return actionRow(kind, lines, options, true).length <= inner
}

export type CardLine = { text: string; role: 'main' | 'ready' | 'gap' | 'note' | 'option' }

// Card hierarchy from the ask text alone (zero wire additions): the first
// line is the sentence being asked, checklist rows carry ASCII role markers
// ('ok ' ready / '-- ' gap / '>> ' option — one choice per line, so the
// answer keys read as choices) the renderer colors and drops, and everything
// else is a quieter note.
export function cardLines(text: string): CardLine[] {
  const lines: CardLine[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    if (raw.startsWith('ok ')) lines.push({ text: raw.slice(3), role: 'ready' })
    else if (raw.startsWith('-- ')) lines.push({ text: raw.slice(3), role: 'gap' })
    else if (raw.startsWith('>> ')) lines.push({ text: raw.slice(3), role: 'option' })
    else if (lines.length === 0) {
      // The opening line splits at its first question mark (ref B1): the lead
      // sentence carries the light, the detail after it steps back.
      const cut = raw.indexOf('? ')
      if (cut !== -1 && cut < raw.length - 2) {
        lines.push({ text: raw.slice(0, cut + 1), role: 'main' })
        lines.push({ text: raw.slice(cut + 2), role: 'note' })
      } else lines.push({ text: raw, role: 'main' })
    } else lines.push({ text: raw, role: 'note' })
  }
  // A checklist card ends on the invitation — facts above, the decision below
  // (the renderer draws the divider); the invite reads at full brightness.
  const last = lines.at(-1)
  if (last?.role === 'note' && lines.some((l) => l.role === 'ready' || l.role === 'gap')) {
    last.role = 'main'
  }
  return lines
}

// How many terminal rows the spotlight card stands on — the renderer's own
// width and chrome math replayed as a number. The raster layer needs it: a
// kitty image sits ABOVE text cells, so while the card is up the sky's images
// may keep the stage (dimmed) only where the card cannot reach.
export function cardRows(text: string, cols: number, kind: AskKind, options?: readonly AskOption[], back = false): number {
  const width = Math.min(Math.floor(cols * 0.55), cols - 4)
  const inner = Math.max(width - 6, 1) // border (2) + horizontal padding (4)
  // A list card draws its rows from `options`; the text's own '>> ' rows are
  // the same rows for a client without a list surface, so they are skipped.
  const lines = cardLines(text).filter((line) => options === undefined || line.role !== 'option')
  const facts = lines.some((line) => line.role === 'ready' || line.role === 'gap')
  let rows = 0
  for (const line of lines) {
    const marker =
      line.role === 'ready' || line.role === 'gap' ? 4 : line.role === 'option' ? 3 : 0
    rows += Math.max(1, Math.ceil((line.text.length + marker) / inner))
  }
  for (const option of options ?? []) rows += Math.max(1, Math.ceil(listRow(option).length / inner))
  if (facts) rows += 1 // the divider above the options
  // A consent checklist's choices are its own option rows; every other card
  // keeps the renderer's action row (a question's Enter hint stays even
  // above status rows — the /sources menu).
  // The action row: its top margin + the line, + the /back hint's own row
  // when it does not share the line.
  if (!(facts && kind === 'consent')) {
    const inline = back && backInline(kind, lines, options, inner)
    rows += 1 + Math.ceil(actionRow(kind, lines, options, inline).length / inner) + (back && !inline ? 1 : 0)
  }
  // The list IS the answer: no field under it.
  if (options === undefined) rows += 2 // the in-card answer field (its top margin + the input)
  rows += 4 // border (2) + vertical padding (2)
  rows += 1 // the gap row between the floating card and the bottom rule
  return rows
}

// The first terminal row the card can touch: the card floats anchored to the
// window's bottom rule (the quiet line that keeps the frame closed), so its
// top is the window height minus its own rows. Rasters end above this.
export function cardTopRow(text: string, cols: number, height: number, kind: AskKind, options?: readonly AskOption[], back = false): number {
  return Math.max(1, height - 1 - cardRows(text, cols, kind, options, back))
}

// One list row as the renderer lays it out: the cursor slot, the tick box,
// the label, the note.
export function listRow(option: AskOption): string {
  return `  [${option.checked === true ? 'x' : ' '}] ${option.label}${option.note === undefined ? '' : `  ${option.note}`}`
}

// The list card's cursor and ticks (spec 10 §3.2-B, rows to tick): up/down move,
// Space toggles the row under the cursor (a single-pick list keeps one),
// Enter answers with the ticked keys in row order — the `line` the flow
// reads. Pure, so app.tsx only has to hold the state and draw it.
export type Pick = { at: number; checked: readonly string[] }

export function pickStart(options: readonly AskOption[]): Pick {
  return { at: 0, checked: options.filter((o) => o.checked === true).map((o) => o.key) }
}

export function pickMove(pick: Pick, delta: number, count: number): Pick {
  return { ...pick, at: Math.max(0, Math.min(count - 1, pick.at + delta)) }
}

export function pickToggle(pick: Pick, options: readonly AskOption[], multi: boolean): Pick {
  const key = options[pick.at]?.key
  if (key === undefined) return pick
  if (!multi) return { ...pick, checked: pick.checked.includes(key) ? [] : [key] }
  return { ...pick, checked: pick.checked.includes(key) ? pick.checked.filter((k) => k !== key) : [...pick.checked, key] }
}

export function pickAnswer(pick: Pick, options: readonly AskOption[]): string {
  return options.filter((o) => pick.checked.includes(o.key)).map((o) => o.key).join(' ')
}

// What a submitted line becomes on the wire. While a question is docked,
// EVERY line — the empty skip included (spec 06 §2.1: Enter skips a seed
// question) — is its answer; idle empty lines stay local noise, as before.
export function outbound(text: string, askActive: boolean): string | null {
  return askActive || text.trim() !== '' ? text : null
}

export type Command = (typeof COMMANDS)[number]

// The slash-command menu's rows (spec 10 §3.2-C: the engine owns the grammar;
// the client only surfaces the shared COMMANDS list). A line opening with `/`
// could still become any of these; once it IS one the menu closes — the
// input's ink change carries the confirmation instead.
export function commandMatches(typed: string): readonly Command[] {
  const line = typed.trim()
  if (!line.startsWith('/') || isCommand(line)) return []
  return COMMANDS.filter((command) => command.name.startsWith(line))
}

// The resting input's invitations (spec 14 §3.8): the talk-back line first
// (the page keys named, since the log scrolls no other way — master §3.6
// keeps the mouse out), then the engine's CURRENT rows — context-gated and fading engine-side, so
// the client only ever rotates what it was given. Command first, why after:
// a narrow field clips the tail, and the command is the half worth keeping.
export function inputHints(rows: readonly Invitation[]): string[] {
  return ['type to talk back · / for commands · scroll or PgUp/PgDn', ...rows.map((row) => `${row.command} · ${row.why}`)]
}

// A lap slow enough to read as furniture rather than a blinking sign.
export const HINT_ROTATE_MS = 3 * 60_000

export function isCommand(typed: string): boolean {
  const line = typed.trim()
  return COMMANDS.some((command) => command.name === line)
}

// How much of the outgoing screen a PageUp/PageDown leaves behind (§3.4). A
// full-viewport jump shares no line with the screen it replaced, and the
// reader has to find their place again — two rows is enough to land on.
export const PAGE_OVERLAP = 2

// One page of the program log, in rows. Floored at a single row: in a log
// already down to its six-row floor the overlap would otherwise eat the whole
// step, and a key that moves nothing reads as a key that is broken.
export function pageStep(viewportRows: number): number {
  return Math.max(1, viewportRows - PAGE_OVERLAP)
}

// Whether the reader has scrolled the log away from its tail. Held away, the
// log stops trimming its head: dropping the oldest entry shifts everything
// under it up by that entry's height, and a numeric scroll position cannot see
// it happen — the reader would silently skip forward while standing still. ONE
// row off the tail already counts, since that is a single wheel notch.
export function heldAwayFromTail(scrollTop: number, height: number, scrollHeight: number): boolean {
  return scrollTop + height < scrollHeight
}

// The same gesture at two grains (§3.4): a page key jumps a screenful, the
// wheel creeps a row. With mouse reporting never armed, the terminal's
// alternate-scroll mode hands a wheel notch over as an Up/Down arrow, so the
// arrows scroll the log whenever no card, menu or pane has claimed them.
// Null for every other key — they all belong to someone else.
export function logScrollDelta(key: string, viewportRows: number): number | null {
  if (key === 'up') return -1
  if (key === 'down') return 1
  if (key === 'pageup') return -pageStep(viewportRows)
  if (key === 'pagedown') return pageStep(viewportRows)
  return null
}

// How many of the log's rows the listener can actually READ. An overlay — a
// spotlight card, the command menu — floats above the text layer and takes no
// rows from the composition (§3.3), so the scrollbox's own height overstates
// what is visible by however far the overlay reaches into it. Paging by the
// full height would then step past the covered rows and they would never be
// shown: below the fold on the way down, above it on the way back.
export function visibleLogRows(top: number, height: number, overlayTop: number | null): number {
  if (overlayTop === null) return height
  return Math.max(1, Math.min(height, overlayTop - top))
}

// --- the notice card (spec 10 §3.2-E) -------------------------------------- //
//
// A card the listener READS while something waits on it — a sign-in code. It
// takes no answer, so the resting input stays where it is and the card floats
// above it (where the command menu floats), and its body is drawn VERBATIM: a
// QR is 21 to 25 rows of half-blocks, 49 columns wide, and one wrapped row
// makes it unscannable. That is also why the geometry below is exact rather
// than estimated — nothing here folds.

export type Notice = Extract<EngineMessage, { type: 'notice' }>

// The escape hatch, lit like the /back hint: the key, then its quiet why.
export const NOTICE_CANCEL_KEY = 'esc'
export const NOTICE_CANCEL_WHY = ' - cancel'
export const NOTICE_CANCEL = `${NOTICE_CANCEL_KEY}${NOTICE_CANCEL_WHY}`

// The footer as the renderer lays it out: the flow's own words, and whether
// they end on the cancel the renderer lights.
export function noticeFooter(footer: string): { lead: string; cancel: boolean } {
  return footer.endsWith(NOTICE_CANCEL)
    ? { lead: footer.slice(0, -NOTICE_CANCEL.length), cancel: true }
    : { lead: footer, cancel: false }
}

// The card's width: its content's, not a share of the terminal. A question
// card wraps to 55% and reads fine; a code cannot wrap, so the card is cut to
// it — bounded by the terminal. `lines` is the title and the body together:
// the border spends the same room on the title it does on a body row.
export function noticeWidth(lines: readonly string[], cols: number): number {
  const need = Math.max(0, ...lines.map((line) => line.length)) + 6 // border (2) + padding (4)
  return Math.min(need, cols - 4)
}

// How many terminal rows the card stands on, for the body actually drawn.
export function noticeRows(body: readonly string[], footer?: string): number {
  return body.length + (footer === undefined ? 0 : 2) + 4 // the footer's top margin; border (2) + padding (2)
}

// How far short the terminal is of the whole card — rows counting the gap row
// and the input it floats above, columns counting the border and the padding.
// Both zero = it fits. Columns matter as much as rows: a folded code is as
// unscannable as a cut one, and does not even look broken (codex review).
export function noticeShortfall(notice: Notice, cols: number, height: number, inputRows: number): { rows: number; cols: number } {
  const wide = Math.max(0, ...notice.body.map((line) => line.length)) + 6
  return {
    rows: Math.max(0, noticeRows(notice.body, notice.footer) + 1 + inputRows - height),
    cols: Math.max(0, wide - (cols - 4)),
  }
}

// What the card draws. A code shown half, or folded, is worse than no code:
// the listener scans it, nothing happens, and nothing on screen says why — so
// a terminal that cannot hold the whole body is told the numbers instead.
// (That sentence is prose and may itself wrap on a very narrow terminal, which
// costs the geometry below a row; a terminal that small has bigger problems.)
export function noticeBody(notice: Notice, cols: number, height: number, inputRows: number): string[] {
  const short = noticeShortfall(notice, cols, height, inputRows)
  if (short.rows === 0 && short.cols === 0) return [...notice.body]
  const missing = [
    ...(short.rows > 0 ? [`${short.rows} row${short.rows === 1 ? '' : 's'}`] : []),
    ...(short.cols > 0 ? [`${short.cols} column${short.cols === 1 ? '' : 's'}`] : []),
  ]
  return [`this terminal is ${missing.join(' and ')} short for the code`]
}

// The first terminal row the card can touch — the rasters end above it and
// the log pages by what is left, exactly as they do under a question.
export function noticeTopRow(notice: Notice, cols: number, height: number, inputRows: number): number {
  return Math.max(1, height - 1 - inputRows - noticeRows(noticeBody(notice, cols, height, inputRows), notice.footer))
}

// Whether the command menu is up. It is furniture UNDER the notice card, which
// covers it whole: a menu the listener cannot see must not go on taking Esc,
// which is the only way out of a sign-in wait — with 'esc - cancel' printed on
// the card saying so (codex review).
export function menuIsOpen(matches: number, over: { hidden: boolean; pane: boolean; asks: number; notice: boolean }): boolean {
  return matches > 0 && !over.hidden && !over.pane && over.asks === 0 && !over.notice
}
