// Harness tool for batched talk generation (spec 04 §3.2 shape, spec 03-01
// termination rule): the model returns its N spoken beats by CALLING
// emit_talk_beats, so the SDK hands them over as validated, typed args — the
// zod schema is both the wire contract and the static type (issue #54 rule:
// parse, don't cast). The capture callback is the terminal-result channel:
// once it fires, the task is done.

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type { Task, TalkBeat } from '../contracts.ts'
import { buildStockLinesPrompt } from '../prompts/talk.ts'
import { hostSystemPrompt } from '../prompts/persona.ts'
import type { StockRequest, StockSet } from '../support/stock.ts'

const beatSchema = z.object({
  text: z.string().describe('the spoken beat, a few sentences'),
  topic: z.string().optional().describe('optional 2-5 word key for anti-repeat'),
})

const beatsShape = {
  beats: z.array(beatSchema).min(1).describe('the next spoken beats, in order'),
}

// Trim, drop empties, and cap at `count` (a model that over-produces must not
// inflate the batch). Runs on already-schema-validated input.
export function cleanBeats(raw: z.infer<typeof beatSchema>[], count: number): TalkBeat[] {
  const beats: TalkBeat[] = []
  for (const b of raw) {
    const text = b.text.trim()
    if (!text) continue
    const topic = b.topic?.trim()
    beats.push({ text, ...(topic && { topic }) })
    if (beats.length >= count) break
  }
  return beats
}

export function emitTalkBeatsTool(count: number, capture: (beats: TalkBeat[]) => void) {
  return tool(
    'emit_talk_beats',
    'Return your next spoken radio beats as an array, in order — each beat is ' +
      'an object with `text` (a few sentences of clean spoken text: no markup, ' +
      'speaker labels, quotation marks, or stage directions) and an optional ' +
      '`topic` (a 2-5 word key naming what the beat is about, for anti-repeat). ' +
      'Calling this ends the task.',
    beatsShape,
    async (args) => {
      const beats = cleanBeats(args.beats, count)
      if (beats.length > 0) capture(beats)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, beats: beats.length }) }] }
    },
  )
}

// The stock lines (spec 04 §3.6): the same terminal-call shape as the talk
// beats — the opener set in order, plus the sign-off when that slot is due.
const stockShape = {
  opener: z.array(z.string()).min(1).describe('the opening beats, in order'),
  farewell: z.string().optional().describe('the one line said as the program goes off the air'),
}

export function emitStockLinesTool(count: number, wantFarewell: boolean, capture: (set: StockSet) => void) {
  return tool(
    'emit_stock_lines',
    'Return the lines you were asked for: `opener`, the opening beats in order' +
      (wantFarewell ? ', and `farewell`, the single sign-off line' : '') +
      '. Each is clean spoken text — no markup, speaker labels, quotation marks, ' +
      'or stage directions. Calling this ends the task.',
    stockShape,
    async (args) => {
      const opener = args.opener.map((t) => t.trim()).filter((t) => t !== '').slice(0, count)
      const farewell = wantFarewell ? args.farewell?.trim() : undefined
      if (opener.length > 0) capture({ opener, ...(farewell && { farewell }) })
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, opener: opener.length }) }] }
    },
  )
}

// The stock generation as a task (spec 04 §3.6): one bounded call in the
// host's own voice, off the live loop, that hands back the whole set at once.
const STOCK_MAX_TURNS = 2

export function stockLinesTask(req: StockRequest, model: string): Task<StockSet> {
  return {
    systemPrompt: hostSystemPrompt(req.persona),
    prompt: buildStockLinesPrompt(req),
    model,
    maxTurns: STOCK_MAX_TURNS,
    tools: (finish) => [emitStockLinesTool(req.count, req.farewell, finish)],
  }
}
