// The planning call (spec 15 §2.4): one harness task that prepares a whole
// program — subject, angle, and an outline whose points carry the material.
// The host's own system prompt, the SDK's default thinking (the task WRITES),
// and one terminal tool.

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type { Task } from '../contracts.ts'
import { hostSystemPrompt } from '../prompts/persona.ts'
import { buildPlanPrompt, type PlanPromptInput } from '../prompts/program.ts'
import type { Plan, Point } from './catalogue.ts'

export type PlanRequest = PlanPromptInput & { readonly persona: string }

const PLAN_MAX_TURNS = 2

const planShape = {
  name: z.string().describe("the program's name on your air"),
  subject: z.string().describe("the canonical subject, in the program's subject format"),
  leads: z.array(z.string()).optional().describe('the thinker or thinkers who lead the program, when asked for'),
  angle: z.string().describe('your way into the subject'),
  points: z
    .array(
      z.object({
        title: z.string().describe('what this point is'),
        content: z.string().describe('the material: original text, facts with their sources, your argument'),
        track: z
          .object({ artist: z.string(), title: z.string() })
          .optional()
          .describe('the track this point plays, when the program plays tracks'),
      }),
    )
    .min(1)
    .max(10),
}

type RawPlan = z.infer<z.ZodObject<typeof planShape>>

// Trim, drop empty points. Null = nothing left to air.
export function cleanPlan(raw: RawPlan): Plan | null {
  const points: Point[] = raw.points.flatMap((p) => {
    const title = p.title.trim()
    const content = p.content.trim()
    if (title === '' && content === '') return []
    const track = p.track === undefined ? undefined : { artist: p.track.artist.trim(), title: p.track.title.trim() }
    return [{ title, content, ...(track !== undefined && track.title !== '' && { track }) }]
  })
  const subject = raw.subject.trim()
  if (points.length === 0 || subject === '') return null
  const leads = raw.leads?.map((l) => l.trim()).filter((l) => l !== '')
  return {
    name: raw.name.trim(),
    subject,
    ...(leads !== undefined && leads.length > 0 && { leads }),
    angle: raw.angle.trim(),
    points,
  }
}

export function planTask(req: PlanRequest, model: string): Task<Plan> {
  return {
    category: 'plan',
    systemPrompt: hostSystemPrompt(req.persona),
    prompt: buildPlanPrompt(req),
    model,
    maxTurns: PLAN_MAX_TURNS,
    tools: (finish) => [
      tool(
        'submit_plan',
        'Hand over the prepared program: its name, subject, angle and outline. ' +
          'Call it once; calling it ends the task.',
        planShape,
        async (args) => {
          const plan = cleanPlan(args)
          if (plan !== null) finish(plan)
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: plan !== null, points: plan?.points.length ?? 0 }) }],
          }
        },
      ),
    ],
  }
}
