// The conversational half of the settings layer (spec 12 §2.6, spec 11 §2.1):
// telling murmur and pressing a key in /settings are the same act, because the
// tool handler calls the same SettingsStore.set the pane's patch reaches.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SteerActions } from '../src/contracts.ts'
import type { Settings } from '../src/ipc.ts'
import { SettingsStore } from '../src/settings.ts'
import { steerTools } from '../src/steer-tools.ts'
import { callTool } from './fakes.ts'

const BASE: Settings = {
  anchorsEnabled: true,
  musicEnabled: true,
  cadenceMode: 'every_n',
  musicEveryN: 2,
  gapSeconds: 2,
  recentWindow: 12,
  muted: false,
  tuiPet: true,
}

function harness(initial: Partial<Settings> = {}, wired: { music?: boolean } = {}) {
  const store = new SettingsStore({
    path: join(mkdtempSync(join(tmpdir(), 'murmur-steer-')), 'settings.json'),
    initial: { ...BASE, ...initial },
    touched: {},
  })
  const actions: SteerActions = {
    shutdown: { armed: () => false, arm: () => {}, confirm: () => {} },
    settings: store,
    ...(wired.music === true && {
      music: { playing: () => false, switchTrack: () => {} },
    }),
  }
  const tools = steerTools(actions, () => {})
  const call = (args: Record<string, unknown>) =>
    callTool(tools, 'change_settings', args) as Promise<{
      ok: boolean
      error?: string
      applied?: unknown
    }>
  return { store, call }
}

describe('change_settings (spec 12 §2.6)', () => {
  it('is not offered at all when no settings store is wired', () => {
    const tools = steerTools(
      { shutdown: { armed: () => false, arm: () => {}, confirm: () => {} } },
      () => {},
    )
    expect(tools.some((t) => t.name === 'change_settings')).toBe(false)
  })

  it('speaks intent, and lands on the same store the pane writes', async () => {
    const { store, call } = harness({}, { music: true })
    expect((await call({ music: false })).ok).toBe(true)
    expect(store.current().musicEnabled).toBe(false)

    expect((await call({ sound: 'muted' })).ok).toBe(true)
    expect(store.current().muted).toBe(true)

    expect((await call({ anchors: false, pet: false })).ok).toBe(true)
    expect(store.current().anchorsEnabled).toBe(false)
    expect(store.current().tuiPet).toBe(false)
  })

  it('translates the mix gear the way the pane does, never raw field names', async () => {
    const { store, call } = harness({}, { music: true })
    expect((await call({ mix: 'more talk' })).ok).toBe(true)
    expect(store.current().cadenceMode).toBe('every_n')
    expect(store.current().musicEveryN).toBe(4)

    expect((await call({ mix: 'more music' })).ok).toBe(true)
    expect(store.current().musicEveryN).toBe(1)
  })

  it('sets and clears the language override (spec 12 §3.9)', async () => {
    const { store, call } = harness()
    expect((await call({ language: 'Japanese' })).ok).toBe(true)
    expect(store.current().language).toBe('Japanese')
    // Empty hands the language back to the persona rather than storing a blank.
    expect((await call({ language: '' })).ok).toBe(true)
    expect(store.current().language).toBeUndefined()
  })

  it('takes the numeric knobs within their bounds and refuses nonsense', async () => {
    const { store, call } = harness()
    expect((await call({ breathingRoom: 4.5 })).ok).toBe(true)
    expect(store.current().gapSeconds).toBe(4.5)
    expect((await call({ memorySpan: 24 })).ok).toBe(true)
    expect(store.current().recentWindow).toBe(24)

    expect((await call({ breathingRoom: -1 })).ok).toBe(false)
    expect(store.current().gapSeconds).toBe(4.5)
  })

  // A confused model must be told, not silently believed: an empty call that
  // returned ok would be narrated as a change that never happened.
  // codex review: the pane greys the music items when the pipeline is missing.
  // Accepting them here would return {ok:true} for something that can never
  // play — the model would then narrate a change the radio cannot make.
  it('refuses the music knobs when this run has no music pipeline', async () => {
    const { store, call } = harness()
    const out = await call({ music: true })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/music/i)
    expect(store.current().musicEnabled).toBe(true)
    expect((await call({ mix: 'more talk' })).ok).toBe(false)
    // Everything else on the same call surface still works.
    expect((await call({ sound: 'muted' })).ok).toBe(true)
  })

  it('takes the music knobs when the pipeline IS wired', async () => {
    const { store, call } = harness({}, { music: true })
    expect((await call({ music: false })).ok).toBe(true)
    expect(store.current().musicEnabled).toBe(false)
  })

  it('errors on a call that asks for nothing', async () => {
    const { call } = harness()
    const out = await call({})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/nothing/i)
  })

  // spec 11 §3.2: the result states what is true at return time, so the reply
  // composed after it cannot promise a change the store rejected.
  it('reports what actually landed', async () => {
    const { call } = harness()
    const out = await call({ language: 'French' })
    expect(out.ok).toBe(true)
    expect(JSON.stringify(out.applied)).toMatch(/French/)
  })
})

// --- the memory tools (spec 05-01 §2.2) ------------------------------------ //

describe('recall_memory / forget_memory', () => {
  const hit = (text: string, role: 'user' | 'radio' | 'faded' = 'user') => ({
    ts: Date.parse('2026-08-15T09:30:00Z') / 1000,
    role,
    text,
    score: 1,
  })

  function memoryHarness(wired: boolean) {
    const calls: { recall: string[]; forget: string[] } = { recall: [], forget: [] }
    const actions: SteerActions = {
      shutdown: { armed: () => false, arm: () => {}, confirm: () => {} },
      ...(wired && {
        memory: {
          recall: (query: string) => {
            calls.recall.push(query)
            return query === 'lantern' ? [hit('the lantern on the balcony')] : []
          },
          forget: (what: string) => {
            calls.forget.push(what)
            return what === 'lantern' ? { rows: 2, lines: 1 } : { rows: 0, lines: 0 }
          },
        },
      }),
    }
    return { calls, tools: steerTools(actions, () => {}) }
  }

  it('offers neither tool when memory is not wired', () => {
    const names = memoryHarness(false).tools.map((t) => t.name)
    expect(names).not.toContain('recall_memory')
    expect(names).not.toContain('forget_memory')
    expect(names).toContain('submit_reply')
  })

  it('offers both tools when memory is wired', () => {
    const names = memoryHarness(true).tools.map((t) => t.name)
    expect(names).toContain('recall_memory')
    expect(names).toContain('forget_memory')
  })

  it('returns the hits as a dated, attributed block', async () => {
    const { tools, calls } = memoryHarness(true)
    const found = (await callTool(tools, 'recall_memory', { query: 'lantern' })) as {
      found: number
      memory: string
    }
    expect(calls.recall).toEqual(['lantern'])
    expect(found.found).toBe(1)
    expect(found.memory).toContain('(From memory)')
    expect(found.memory).toContain('2026-08-15')
    expect(found.memory).toContain('the lantern on the balcony')
  })

  it('says plainly when it recalls nothing, rather than returning an empty block', async () => {
    const { tools } = memoryHarness(true)
    const found = (await callTool(tools, 'recall_memory', { query: 'trombone' })) as {
      found: number
      memory: string
    }
    expect(found.found).toBe(0)
    expect(found.memory).toBe('')
  })

  it('reports what forgetting removed, and reports nothing removed as zero', async () => {
    const { tools, calls } = memoryHarness(true)
    const gone = (await callTool(tools, 'forget_memory', { what: 'lantern' })) as {
      removed: number
    }
    expect(calls.forget).toEqual(['lantern'])
    expect(gone.removed).toBe(3)
    const none = (await callTool(tools, 'forget_memory', { what: 'trombone' })) as {
      removed: number
    }
    expect(none.removed).toBe(0)
  })
})
