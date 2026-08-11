// The spotlight card's pure logic (spec 10 §3.2-B as built): the title names
// the kind of answer (with a light question counter), each card line carries a
// role the renderer colors by, and outbound() decides what a submitted line
// becomes. Rendering itself stays untested (spec 10 §3.9).

import { describe, expect, it } from 'vitest'

import { cardLines, cardTitle, outbound } from '../tui/src/dock.ts'

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
