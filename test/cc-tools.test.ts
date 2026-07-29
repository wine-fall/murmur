import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ccTools, MAX_READ_CHARS, MAX_SESSIONS } from '../src/cc-tools.ts'
import type { ProfileBootstrap } from '../src/cc-tools.ts'
import { PROFILE_CHAR_CAP } from '../src/prompts.ts'
import { callTool } from './fakes.ts'

// A throwaway Claude-Code data root: <root>/projects/<project>/<session>.jsonl
// plus the optional <root>/CLAUDE.md.
function ccRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'murmur-cc-'))
  mkdirSync(join(root, 'projects'), { recursive: true })
  return root
}

function session(root: string, project: string, name: string, rows: unknown[], mtime?: number): string {
  const dir = join(root, 'projects', project)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.jsonl`)
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n'))
  if (mtime !== undefined) utimesSync(path, mtime, mtime)
  return path
}

const turn = (role: 'user' | 'assistant', text: string) => ({
  type: role,
  message: { role, content: [{ type: 'text', text }] },
})

function tools(root: string): { tools: ReturnType<typeof ccTools>; finished: ProfileBootstrap[] } {
  const finished: ProfileBootstrap[] = []
  return { tools: ccTools(root, (b) => finished.push(b)), finished }
}

async function listed(root: string): Promise<{
  tools: ReturnType<typeof ccTools>
  finished: ProfileBootstrap[]
  sessions: { id: string; project: string; bytes: number }[]
}> {
  const t = tools(root)
  const result = await callTool(t.tools, 'list_sessions', {})
  return { ...t, sessions: result.sessions as { id: string; project: string; bytes: number }[] }
}

describe('the CC reader tool set (spec 06 §2.3)', () => {
  it('exposes exactly the four read/submit tools — nothing that writes', () => {
    const names = tools(ccRoot()).tools.map((t) => t.name)
    expect(names).toEqual(['list_sessions', 'read_session', 'read_instructions', 'submit_profile'])
  })

  it('lists session metadata newest-first, with project and size', async () => {
    const root = ccRoot()
    session(root, 'alpha', 'old', [turn('user', 'a'), turn('assistant', 'b')], 1_000_000)
    session(root, 'beta', 'new', [turn('user', 'c')], 2_000_000)
    const { sessions } = await listed(root)
    expect(sessions.map((s) => s.project)).toEqual(['beta', 'alpha'])
    expect(sessions[0]!.bytes).toBeGreaterThan(0)
  })

  it('opens no session file at all: the listing is stat-only (codex review)', async () => {
    // Counting turns here would read every one of MAX_SESSIONS histories in
    // full, synchronously, in the live radio's process. An unreadable file
    // therefore must not disturb the listing.
    const root = ccRoot()
    const path = session(root, 'alpha', 'one', [turn('user', 'hi')])
    chmodSync(path, 0o000)
    try {
      const { sessions } = await listed(root)
      expect(sessions).toHaveLength(1)
      expect(sessions[0]!.bytes).toBeGreaterThan(0)
    } finally {
      chmodSync(path, 0o600)
    }
  })

  it('caps the listing at MAX_SESSIONS newest entries', async () => {
    const root = ccRoot()
    for (let i = 0; i < MAX_SESSIONS + 5; i++) {
      session(root, 'alpha', `s${i}`, [turn('user', `line ${i}`)], 1_000_000 + i)
    }
    const { tools: t, sessions } = await listed(root)
    expect(sessions).toHaveLength(MAX_SESSIONS)
    // The newest survived the cut, the oldest did not.
    const newest = await callTool(t, 'read_session', { id: sessions[0]!.id })
    expect(String(newest.text)).toContain(`line ${MAX_SESSIONS + 4}`)
  })

  it('mints opaque ids — never caller-usable paths', async () => {
    const root = ccRoot()
    session(root, 'alpha', 'one', [turn('user', 'hi')])
    const { sessions } = await listed(root)
    expect(sessions[0]!.id).not.toContain('/')
    expect(sessions[0]!.id).not.toContain('.jsonl')
  })

  it('an empty or missing data root lists nothing instead of throwing', async () => {
    expect((await listed(join(tmpdir(), 'murmur-cc-does-not-exist'))).sessions).toEqual([])
    expect((await listed(ccRoot())).sessions).toEqual([])
  })
})

describe('read_session (the trust boundary — spec 06 §2.3)', () => {
  it('refuses an id list_sessions never minted', async () => {
    const root = ccRoot()
    session(root, 'alpha', 'one', [turn('user', 'hi')])
    const { tools: t } = await listed(root)
    const denied = await callTool(t, 'read_session', { id: 'made-up' })
    expect(denied.ok).toBe(false)
    expect(String(denied.error)).toMatch(/unknown session/i)
  })

  it('refuses before any listing has minted ids at all', async () => {
    const root = ccRoot()
    session(root, 'alpha', 'one', [turn('user', 'hi')])
    const t = tools(root)
    expect((await callTool(t.tools, 'read_session', { id: 's1' })).ok).toBe(false)
  })

  it('never lists or serves a session symlinked outside the data root', async () => {
    const root = ccRoot()
    const outside = mkdtempSync(join(tmpdir(), 'murmur-secret-'))
    const secret = join(outside, 'secrets.jsonl')
    writeFileSync(secret, JSON.stringify(turn('user', 'ssh private key')))
    mkdirSync(join(root, 'projects', 'alpha'), { recursive: true })
    symlinkSync(secret, join(root, 'projects', 'alpha', 'escape.jsonl'))
    session(root, 'alpha', 'legit', [turn('user', 'hi')])

    const { tools: t, sessions } = await listed(root)
    expect(sessions).toHaveLength(1)
    for (const s of sessions) {
      const read = await callTool(t, 'read_session', { id: s.id })
      expect(String(read.text)).not.toContain('ssh private key')
    }
  })

  it('serves the transcript as speaker-labelled text, tool noise dropped', async () => {
    const root = ccRoot()
    session(root, 'alpha', 'one', [
      { type: 'summary', summary: 'ignore me' },
      turn('user', 'why is the build slow'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x' }] } },
      turn('assistant', 'because of the bundler'),
    ])
    const { tools: t, sessions } = await listed(root)
    const read = await callTool(t, 'read_session', { id: sessions[0]!.id })
    expect(read.ok).toBe(true)
    expect(String(read.text)).toContain('user: why is the build slow')
    expect(String(read.text)).toContain('assistant: because of the bundler')
    expect(String(read.text)).not.toContain('ignore me')
    expect(String(read.text)).not.toContain('tool_use')
  })

  it('refuses a session it cannot read as a transcript rather than shipping raw JSONL (codex review)', async () => {
    // A format change (or a tool-result-only file) must not turn the bounded
    // transcript read into "send Claude the whole file" — tool payloads,
    // pasted buffers and base64 are exactly what the extractor exists to drop.
    const root = ccRoot()
    session(root, 'alpha', 'opaque', [
      { type: 'tool_result', payload: 'BEGIN RSA PRIVATE KEY MIIEow...' },
      { unrecognised: 'shape', blob: 'AAAABBBBCCCC' },
    ])
    const { tools: t, sessions } = await listed(root)
    const read = await callTool(t, 'read_session', { id: sessions[0]!.id })
    expect(read.ok).toBe(false)
    expect(read.text).toBeUndefined()
    expect(JSON.stringify(read)).not.toContain('RSA PRIVATE KEY')
  })

  it('caps the read at maxChars, and clamps maxChars to MAX_READ_CHARS', async () => {
    const root = ccRoot()
    const rows = Array.from({ length: 400 }, (_, i) => turn('user', `line ${i} ${'x'.repeat(200)}`))
    session(root, 'alpha', 'big', rows)
    const { tools: t, sessions } = await listed(root)
    const id = sessions[0]!.id

    const small = await callTool(t, 'read_session', { id, maxChars: 50 })
    expect(String(small.text)).toHaveLength(50)
    expect(small.truncated).toBe(true)

    const greedy = await callTool(t, 'read_session', { id, maxChars: 10_000_000 })
    expect(String(greedy.text).length).toBeLessThanOrEqual(MAX_READ_CHARS)
  })
})

describe('read_instructions / submit_profile', () => {
  it('reads CLAUDE.md from the root when present, and says so plainly when not', async () => {
    const root = ccRoot()
    const { tools: t } = tools(root)
    expect((await callTool(t, 'read_instructions', {})).ok).toBe(false)
    writeFileSync(join(root, 'CLAUDE.md'), 'always answer in Chinese')
    const found = await callTool(tools(root).tools, 'read_instructions', {})
    expect(found.ok).toBe(true)
    expect(String(found.text)).toContain('always answer in Chinese')
  })

  it('finishes the task with the submitted profile', async () => {
    const t = tools(ccRoot())
    const result = await callTool(t.tools, 'submit_profile', { profile: '(About the listener)\nnight owl' })
    expect(result.ok).toBe(true)
    expect(t.finished).toHaveLength(1)
    expect(t.finished[0]!.profile).toContain('night owl')
  })

  it('caps the submitted profile and refuses an empty one (non-terminal)', async () => {
    const t = tools(ccRoot())
    const empty = await callTool(t.tools, 'submit_profile', { profile: '   ' })
    expect(empty.ok).toBe(false)
    expect(t.finished).toHaveLength(0)

    await callTool(t.tools, 'submit_profile', { profile: 'y'.repeat(PROFILE_CHAR_CAP * 2) })
    expect(t.finished[0]!.profile).toHaveLength(PROFILE_CHAR_CAP)
  })
})
