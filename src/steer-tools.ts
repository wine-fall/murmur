// The steer task's tools (spec 11 §2.1): the reply turn's hands. switch_music
// re-primes the pick and marks the handover, end_broadcast is two-phase by
// construction (an unarmed call can only arm and ask), and submit_reply is the
// terminal tool that ends the task with the spoken reply.
//
// Every handler acts (or durably schedules) before it returns, and its result
// states exactly what is true at return time — the reply is composed after the
// results, so narration follows delivery (spec 11 §3.2).

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type { SteerActions, TaskTool } from './contracts.ts'

function reply(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

export function steerTools(actions: SteerActions, finish: (replyText: string) => void): TaskTool[] {
  const tools: TaskTool[] = []

  const music = actions.music
  if (music !== undefined) {
    tools.push(
      tool(
        'switch_music',
        'The listener asked for different music (skip this, next song, or a ' +
          'specific style/artist/mood — put that in `hint`). Re-aims the next ' +
          'pick; the air hands over once it is found.',
        {
          hint: z
            .string()
            .optional()
            .describe("the requested style, artist, or mood, in the listener's words"),
        },
        async (args) => {
          const wasPlaying = music.playing()
          music.switchTrack(args.hint)
          const status = wasPlaying
            ? 'switching; the current track keeps playing while the next one is ' +
              'picked — tell the listener you are on it, ask them to hang on, ' +
              'and do NOT name or promise a specific song'
            : 'no track playing; a fresh pick is being prepared and will air at ' +
              'the next break — do NOT name or promise a specific song'
          return reply({ ok: true, status })
        },
      ),
    )
  }

  tools.push(
    tool(
      'end_broadcast',
      'The listener EXPLICITLY asked to stop/close the radio. First call: arms ' +
        'shutdown and you must ask them to confirm. Call it again on a later ' +
        'turn ONLY once they have confirmed — that closes the radio. Never ' +
        'call it for a mood remark (tiredness is not a request).',
      {},
      async () => {
        if (actions.shutdown.armed()) {
          actions.shutdown.confirm()
          return reply({
            ok: true,
            status: 'closing after your sign-off — make the reply a warm goodbye',
          })
        }
        actions.shutdown.arm()
        return reply({
          ok: true,
          status:
            'not closing yet — ask the listener to confirm they want the radio ' +
            'off; only a later turn where they confirm closes it',
        })
      },
    ),
  )

  tools.push(
    tool(
      'submit_reply',
      'Return your spoken reply to the listener: a few sentences of clean ' +
        'spoken text — no markup, speaker labels, quotation marks, or stage ' +
        'directions. Call any needed action tool FIRST; calling this ends the task.',
      { text: z.string().describe('the spoken reply, in character') },
      async (args) => {
        const text = args.text.trim()
        if (!text) return reply({ ok: false, error: 'submit_reply requires non-empty text' })
        finish(text)
        return reply({ ok: true })
      },
    ),
  )

  return tools
}
