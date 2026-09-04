// Harness tool for batched talk generation (spec 04 §3.2 shape, spec 03-01
// termination rule): the model returns its N spoken beats by CALLING
// emit_talk_beats, so the SDK hands them over as validated, typed args — the
// zod schema is both the wire contract and the static type (issue #54 rule:
// parse, don't cast). The capture callback is the terminal-result channel:
// once it fires, the task is done.

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type { TalkBeat } from '../contracts.ts'

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
