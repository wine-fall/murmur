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

import type { SteerActions, TaskTool } from '../contracts.ts'
import { LANGUAGE_MAX, MIX_EVERY_N, MIX_NAMES, type SettingsPatch } from '../host/ipc.ts'
import { memoryBlock } from '../prompts/reply.ts'

function reply(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

// The listener's words -> the engine's fields (spec 12 §2.6). The tool's schema
// is the pane's vocabulary, so this is the ONE place the translation happens on
// the conversational side; null = the call asked for nothing.
type SettingsIntent = {
  music?: boolean | undefined
  mix?: (typeof MIX_NAMES)[number] | undefined
  breathingRoom?: number | undefined
  sound?: 'on' | 'muted' | undefined
  anchors?: boolean | undefined
  pet?: boolean | undefined
  memorySpan?: number | undefined
  language?: string | undefined
  rwt?: boolean | undefined
}

function settingsPatch(intent: SettingsIntent): SettingsPatch | null {
  const patch: SettingsPatch = {
    ...(intent.music !== undefined && { musicEnabled: intent.music }),
    ...(intent.mix !== undefined && {
      cadenceMode: 'every_n' as const,
      musicEveryN: MIX_EVERY_N[intent.mix],
    }),
    ...(intent.breathingRoom !== undefined && { gapSeconds: intent.breathingRoom }),
    ...(intent.sound !== undefined && { muted: intent.sound === 'muted' }),
    ...(intent.anchors !== undefined && { anchorsEnabled: intent.anchors }),
    ...(intent.pet !== undefined && { tuiPet: intent.pet }),
    ...(intent.memorySpan !== undefined && { recentWindow: intent.memorySpan }),
    ...(intent.language !== undefined && { language: intent.language }),
    ...(intent.rwt !== undefined && { rwtEnabled: intent.rwt }),
  }
  return Object.keys(patch).length === 0 ? null : patch
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

  const settings = actions.settings
  if (settings !== undefined) {
    tools.push(
      tool(
        'change_settings',
        'The listener EXPLICITLY asked to change how the radio behaves — the ' +
          'same knobs the /settings pane holds. A mood remark is NOT a request: ' +
          '"this song is too loud" is not "mute". Pass only the fields they ' +
          'actually asked about.',
        {
          music: z.boolean().optional().describe('play music at all; false = pure talk radio'),
          mix: z.enum(MIX_NAMES).optional().describe('how much music against talk'),
          breathingRoom: z
            .number()
            .min(0)
            .max(10)
            .optional()
            .describe('seconds of silence between segments'),
          sound: z
            .enum(['on', 'muted'])
            .optional()
            .describe('muted keeps broadcasting, it only gates the output'),
          anchors: z.boolean().optional().describe('the morning and night moments'),
          pet: z.boolean().optional().describe('the pixel pet in the front-end'),
          memorySpan: z
            .number()
            .int()
            .min(4)
            .max(48)
            .optional()
            .describe('how many recent turns it keeps in mind'),
          language: z
            .string()
            .max(LANGUAGE_MAX)
            .optional()
            .describe(
              'the language to speak, as a name ("Japanese", "Traditional ' +
                'Chinese"). Empty string returns it to its own default.',
            ),
          rwt: z
            .boolean()
            .optional()
            .describe('whether the host brings up real-world news and happenings at all'),
        },
        async (args) => {
          // The pane greys the music items when this run has no pipeline; the
          // conversation must refuse them for the same reason, or the model is
          // told {ok:true} about music that can never play.
          if (music === undefined && (args.music !== undefined || args.mix !== undefined)) {
            return reply({
              ok: false,
              error:
                'this run has no music pipeline, so the music knobs cannot be ' +
                'changed — say so plainly instead of promising music',
            })
          }
          const patch = settingsPatch(args)
          if (patch === null) {
            return reply({
              ok: false,
              error: 'change_settings asks for nothing — pass at least one field',
            })
          }
          if (!settings.set(patch)) {
            return reply({ ok: false, error: 'the radio refused those values; nothing changed' })
          }
          // What is true at RETURN time (spec 11 §3.2), so the reply composed
          // afterwards cannot narrate a change that did not land.
          return reply({ ok: true, applied: settings.current() })
        },
      ),
    )
  }

  // The memory tier (spec 05-01 §2.2). Absent on a stub run, where there is
  // nothing on record worth searching.
  const memory = actions.memory
  if (memory !== undefined) {
    tools.push(
      tool(
        'recall_memory',
        'Look something up in what the listener has said to you before, beyond ' +
          'the program above. Use it when they refer to something you cannot ' +
          'see ("that project", "like last time", "do you remember"). Call it ' +
          'AT MOST ONCE per reply, with a few words in their own language.',
        { query: z.string().describe("a few words to search for, in the listener's language") },
        async (args) => {
          const hits = memory.recall(args.query)
          return reply({ ok: true, found: hits.length, memory: memoryBlock(hits) })
        },
      ),
    )
    tools.push(
      tool(
        'forget_memory',
        'The listener EXPLICITLY asked you to forget or erase something. ' +
          'Removes it permanently — there is no undo — so never call it for a ' +
          'mood remark or a passing regret.',
        { what: z.string().describe("the topic or phrase to erase, in the listener's words") },
        async (args) => {
          const { rows, lines } = memory.forget(args.what)
          const removed = rows + lines
          return reply({
            ok: true,
            removed,
            status:
              removed === 0
                ? 'nothing on record matched — say so plainly rather than ' +
                  'claiming to have forgotten something'
                : 'gone for good; tell them it is forgotten',
          })
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
