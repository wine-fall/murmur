// The typed-line turns (spec 01 §3.2 respond, spec 11 §2.2 steer): an
// in-persona reply to what the listener just said — plain, or agentic over the
// steer tools with the rules gated on what the program can actually do.

import type { ContextPack, RecallHit } from '../contracts.ts'

import { OUTPUT_RULES, profileBlock, renderTranscript, statusBlock } from './talk.ts'

// Prompt for an in-persona reply to a typed user line. Carries the profile
// block too (spec 05 §3.5): a direct reply is exactly where cross-session
// listener facts should shape what the host says back.
export function buildRespondPrompt(userText: string, ctx: ContextPack): string {
  const transcript = renderTranscript(ctx, userText)
  const head = transcript ? `(The program so far)\n${transcript}\n\n` : ''
  return (
    `${profileBlock(ctx)}${head}${statusBlock(ctx)}The listener just said to you: "${userText}"\n` +
    `Respond in character, then ease back into the program.\n${OUTPUT_RULES}`
  )
}

// The reply turn's instruction: decide whether the listener's words ask the
// program to DO something, act with the tools, then answer. Bullets are gated
// on the wired capabilities so the model is never offered an action the
// program cannot perform.
const STEER_SWITCH_RULE =
  '- Different or next music, skip this song, or a specific style/artist/mood ' +
  'request -> call switch_music FIRST (put the stated style, artist, or mood ' +
  'in `hint`). In the reply: acknowledge, cover the wait, and never name or ' +
  'promise a specific track — the next one introduces itself when it airs.\n'

const STEER_END_RULE =
  '- An explicit ask to stop or close the radio -> call end_broadcast and ' +
  'follow its status. Never call it for a mood remark (tired is not a request).\n'

// Without this the catch-all below actively told the model NOT to act on a
// settings request (codex review): the tool was in the set, but the prompt said
// anything that is not music or shutdown is just conversation.
const STEER_SETTINGS_RULE =
  '- An explicit ask to change how the radio behaves — music on/off, more ' +
  'music or more talk, breathing room, sound/mute, the morning and night ' +
  'moments, the pixel pet, memory span, the language it speaks, or whether it ' +
  'brings up real-world news and happenings at all -> call ' +
  'change_settings with only the fields they asked about, then say what ' +
  'changed. A mood remark is not a request ("this song is too loud" is not ' +
  '"mute"). For the language, pass the language name; pass an empty string to ' +
  'return to its own default.\n'

const STEER_REPLY_RULE =
  '- Anything the tools above do not cover is just conversation — no action tools.\n\n' +
  'Always finish by calling submit_reply with your spoken reply, in character, ' +
  'easing back into the program.'

// Rides the prompt only while the Director's armed flag is set (spec 11 §2.1):
// the model must know it is in the confirm leg of the two-phase shutdown.
export const STEER_ARMED_NOTE =
  'Shutdown is ARMED: last turn you asked the listener to confirm closing the ' +
  'radio. If this turn confirms it, call end_broadcast again to close; if it ' +
  'does not, do NOT call end_broadcast and just carry on (it disarms on its own).'

// The two memory tools, offered only when the store behind them is real
// (spec 05-01 §3.6). Recall is capped at one call per reply: it rides the turn
// the listener already paid for, and a second lookup is a conversation the
// listener did not ask for.
const STEER_MEMORY_RULE =
  '- The listener refers to something that is NOT in the program above or in ' +
  'what you know about them ("that project", "like last time", "do you ' +
  'remember") -> call recall_memory ONCE with a few words in their language, ' +
  'then answer from what comes back.\n' +
  '- The listener explicitly asks you to forget or erase something -> call ' +
  'forget_memory with the topic in their words, then confirm it is gone. ' +
  'Never for a mood remark.\n'

// The anti-fabrication line for the reply turn: memory is a thing you looked
// up, not a thing you can invent (spec 05-01 §3.6).
const MEMORY_GROUNDING =
  '\n\nOnly mention a past moment that appears in the program above, in what ' +
  'you know about the listener, or in a recall_memory result. Never invent a ' +
  'date, a quote, or a memory.'

// Recall hits, dated and attributed, as the reply turn reads them
// (spec 05-01 §3.6). No hits renders nothing at all — an empty block would
// invite the model to fill it in.
export function memoryBlock(hits: readonly RecallHit[]): string {
  if (hits.length === 0) return ''
  const lines = hits.map((hit) => {
    const day = new Date(hit.ts * 1000).toISOString().slice(0, 10)
    const who =
      hit.role === 'user'
        ? 'the listener said'
        : hit.role === 'radio'
          ? 'you said'
          : 'you knew, and had since let go'
    return `- ${day}, ${who}: "${hit.text}"`
  })
  return `(From memory)\n${lines.join('\n')}`
}

export function buildSteerPrompt(
  userText: string,
  ctx: ContextPack,
  opts: {
    musicWired: boolean
    shutdownArmed: boolean
    settingsWired: boolean
    memoryWired: boolean
  },
): string {
  const transcript = renderTranscript(ctx, userText)
  const head = transcript ? `(The program so far)\n${transcript}\n\n` : ''
  const rules =
    `${opts.musicWired ? STEER_SWITCH_RULE : ''}` +
    `${opts.settingsWired ? STEER_SETTINGS_RULE : ''}` +
    `${opts.memoryWired ? STEER_MEMORY_RULE : ''}` +
    `${STEER_END_RULE}${STEER_REPLY_RULE}${opts.memoryWired ? MEMORY_GROUNDING : ''}`
  const armed = opts.shutdownArmed ? `\n\n${STEER_ARMED_NOTE}` : ''
  return (
    `${profileBlock(ctx)}${head}${statusBlock(ctx)}The listener just said to you: "${userText}"\n\n` +
    `Decide whether their words ask the program to DO something; act with the ` +
    `tools if so, then answer them.\n${rules}${armed}`
  )
}
