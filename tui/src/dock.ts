// The spotlight card's pure logic (spec 10 §3.2-B as built): when the engine
// marks a question (`ask` on the wire), the client dims the room and pins the
// queue head in a centered card above the input. This module shapes the card's
// text; app.tsx renders it (wrapping is <text>'s own — no hand-rolled folding).

import { COMMANDS, type EngineMessage } from '../../src/ipc.ts'

export type Ask = Extract<EngineMessage, { type: 'ask' }>
export type AskKind = Ask['kind']

// The border title, padded so the frame breathes around it. Questions carry a
// light counter — a run of seeds reads as progress; a consent names its
// skippability; a card carrying the checklist is the pre-broadcast check
// (ref B3), whatever kind delivered it.
export function cardTitle(kind: AskKind, count: number, checklist: boolean): string {
  if (checklist) return ' pre-broadcast check '
  return kind === 'consent'
    ? ' murmur needs a yes · optional '
    : ` murmur is asking · #${String(count)} `
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
export function cardRows(text: string, cols: number): number {
  const width = Math.min(Math.floor(cols * 0.55), cols - 4)
  const inner = Math.max(width - 6, 1) // border (2) + horizontal padding (4)
  const lines = cardLines(text)
  const facts = lines.some((line) => line.role === 'ready' || line.role === 'gap')
  let rows = 0
  for (const line of lines) {
    const marker =
      line.role === 'ready' || line.role === 'gap' ? 4 : line.role === 'option' ? 3 : 0
    rows += Math.max(1, Math.ceil((line.text.length + marker) / inner))
  }
  if (facts) rows += 1 // the divider above the options
  // A checklist card's choices are its own option rows; only the plain
  // consent/question cards keep the renderer's action row.
  if (!facts) rows += 2 // the action row (its top margin + the line)
  rows += 2 // the in-card answer field (its top margin + the input)
  rows += 4 // border (2) + vertical padding (2)
  rows += 1 // the gap row between the floating card and the bottom rule
  return rows
}

// The first terminal row the card can touch: the card floats anchored to the
// window's bottom rule (the quiet line that keeps the frame closed), so its
// top is the window height minus its own rows. Rasters end above this.
export function cardTopRow(text: string, cols: number, height: number): number {
  return Math.max(1, height - 1 - cardRows(text, cols))
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

export function isCommand(typed: string): boolean {
  const line = typed.trim()
  return COMMANDS.some((command) => command.name === line)
}
