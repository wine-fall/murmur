// The steer task's tools (spec 11 §2.1) against fake actions: switch_music acts
// then reports truthfully, end_broadcast is two-phase by construction, and
// submit_reply is the terminal channel. Gating: no music wiring, no switch tool.
import { describe, expect, it } from 'vitest'

import type { SteerActions } from '../src/contracts.ts'
import { steerTools } from '../src/steer-tools.ts'
import { callTool } from './fakes.ts'

function fakeActions(opts: { music?: boolean; playing?: boolean; armed?: boolean } = {}) {
  const log: string[] = []
  let armed = opts.armed ?? false
  const actions: SteerActions = {
    ...(opts.music !== false && {
      music: {
        playing: () => opts.playing ?? true,
        switchTrack: (hint?: string) => log.push(`switch:${hint ?? ''}`),
      },
    }),
    shutdown: {
      armed: () => armed,
      arm: () => {
        armed = true
        log.push('arm')
      },
      confirm: () => log.push('confirm'),
    },
  }
  return { actions, log, isArmed: () => armed }
}

describe('tool set gating', () => {
  it('includes switch_music only when music actions are wired', () => {
    const withMusic = steerTools(fakeActions().actions, () => {})
    expect(withMusic.map((t) => t.name).sort()).toEqual(['end_broadcast', 'submit_reply', 'switch_music'])
    const without = steerTools(fakeActions({ music: false }).actions, () => {})
    expect(without.map((t) => t.name).sort()).toEqual(['end_broadcast', 'submit_reply'])
  })
})

describe('switch_music', () => {
  it('invokes the switch with the hint and tells the model the track keeps playing', async () => {
    const { actions, log } = fakeActions({ playing: true })
    const tools = steerTools(actions, () => {})
    const result = await callTool(tools, 'switch_music', { hint: 'slow jazz' })
    expect(log).toEqual(['switch:slow jazz'])
    expect(result.ok).toBe(true)
    expect(String(result.status)).toContain('keeps playing')
    expect(String(result.status)).toContain('do NOT name')
  })

  it('reports no-track-playing without erroring, so the task goes on', async () => {
    const { actions, log } = fakeActions({ playing: false })
    const tools = steerTools(actions, () => {})
    const result = await callTool(tools, 'switch_music', {})
    expect(log).toEqual(['switch:'])
    expect(result.ok).toBe(true)
    expect(String(result.status)).toContain('no track playing')
  })
})

describe('end_broadcast (two-phase)', () => {
  it('an unarmed call arms and asks for confirmation — never closes', async () => {
    const { actions, log, isArmed } = fakeActions()
    const tools = steerTools(actions, () => {})
    const result = await callTool(tools, 'end_broadcast', {})
    expect(log).toEqual(['arm'])
    expect(log).not.toContain('confirm')
    expect(isArmed()).toBe(true)
    expect(String(result.status)).toContain('confirm')
  })

  it('a call while armed confirms the shutdown', async () => {
    const { actions, log } = fakeActions({ armed: true })
    const tools = steerTools(actions, () => {})
    const result = await callTool(tools, 'end_broadcast', {})
    expect(log).toEqual(['confirm'])
    expect(result.ok).toBe(true)
    expect(String(result.status)).toContain('sign-off')
  })
})

describe('submit_reply (terminal)', () => {
  it('finishes the task with the trimmed reply text', async () => {
    let finished: string | null = null
    const tools = steerTools(fakeActions().actions, (reply) => (finished = reply))
    const result = await callTool(tools, 'submit_reply', { text: '  okay, switching it up.  ' })
    expect(finished).toBe('okay, switching it up.')
    expect(result.ok).toBe(true)
  })

  it('rejects an empty reply instead of finishing with silence', async () => {
    let finished: string | null = null
    const tools = steerTools(fakeActions().actions, (reply) => (finished = reply))
    const result = await callTool(tools, 'submit_reply', { text: '   ' })
    expect(finished).toBeNull()
    expect(result.ok).toBe(false)
  })
})
