// The steer task builder (spec 11 §2.2) over the FakeHarness: task shape
// (persona cached as system prompt, main-tier model, bounded turns, gated
// tools), the terminal rule, and the armed-shutdown note riding the prompt.
import { describe, expect, it } from 'vitest'

import type { ContextPack, SteerActions } from '../src/contracts.ts'
import { SteerResponder } from '../src/steer-responder.ts'
import { FakeHarness, callTool } from './fakes.ts'

const ctx: ContextPack = {
  persona: 'the persona',
  recent: [],
  scene: 'afternoon',
  profile: '',
  coveredTopics: [],
}

function actions(armed = false): SteerActions {
  return {
    music: { playing: () => true, switchTrack: () => {} },
    shutdown: { armed: () => armed, arm: () => {}, confirm: () => {} },
  }
}

describe('SteerResponder', () => {
  it('runs a bounded task with the persona as system prompt and returns the finished reply', async () => {
    const harness = new FakeHarness(async (tools) => {
      await callTool(tools, 'submit_reply', { text: 'right here with you.' })
    })
    const responder = new SteerResponder({ brain: harness, model: 'main-model' })
    const reply = await responder.respond('hello?', ctx, actions())
    expect(reply).toBe('right here with you.')
    expect(harness.lastTask?.systemPrompt).toBe('the persona')
    expect(harness.lastTask?.model).toBe('main-model')
    expect(harness.lastTask?.maxTurns).toBe(3)
    expect(harness.lastTask?.prompt).toContain('hello?')
  })

  it('returns null when the model never makes the terminal call', async () => {
    const harness = new FakeHarness(async () => {})
    const responder = new SteerResponder({ brain: harness, model: 'main-model' })
    expect(await responder.respond('hello?', ctx, actions())).toBeNull()
  })

  it('gates the tool set and the instruction on the wired capabilities', async () => {
    let names: string[] = []
    const harness = new FakeHarness(async (tools) => {
      names = tools.map((t) => t.name)
    })
    const responder = new SteerResponder({ brain: harness, model: 'm' })
    await responder.respond('hi', ctx, { shutdown: actions().shutdown })
    expect(names.sort()).toEqual(['end_broadcast', 'submit_reply'])
    expect(harness.lastTask?.prompt).not.toContain('switch_music')
    await responder.respond('hi', ctx, actions())
    expect(harness.lastTask?.prompt).toContain('switch_music')
  })

  it('tells the model when shutdown is armed', async () => {
    const harness = new FakeHarness(async () => {})
    const responder = new SteerResponder({ brain: harness, model: 'm' })
    await responder.respond('yes, close it', ctx, actions(true))
    expect(harness.lastTask?.prompt).toContain('ARMED')
    await responder.respond('hello', ctx, actions(false))
    expect(harness.lastTask?.prompt).not.toContain('ARMED')
  })
})
