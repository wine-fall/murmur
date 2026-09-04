// The profile-bootstrap task's tools (spec 06 §2.3): a read-only, path-scoped
// window onto the user's local Claude Code history, plus the terminal
// submit_profile.
//
// This is a read of the user's private data, so the sandbox is the point, not a
// detail: every path is resolved with realpath and refused if it escapes the CC
// data root (a symlinked session file is therefore unreachable), session ids are
// opaque handles minted by list_sessions rather than caller-supplied paths, and
// there is no tool here that writes anything.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type { TaskTool } from '../contracts.ts'
import { PROFILE_CHAR_CAP } from '../prompts/profile.ts'

// What the terminal tool finishes the task with.
export type ProfileBootstrap = { profile: string }

// Bootstrap depth (spec 06 §6 — unmeasured by-feel bounds). Too shallow reads
// only the newest project; too deep burns a large one-time cost.
export const MAX_SESSIONS = 20
export const MAX_READ_CHARS = 20_000

// A transcript row we can attribute to a speaker. Everything else in a session
// file (summaries, tool calls, meta) is noise for this purpose and is skipped.
// The file boundary is untrusted (issue #54 rule): parsed, never cast.
const transcriptRowSchema = z.object({
  message: z.object({
    role: z.enum(['user', 'assistant']),
    content: z.union([
      z.string(),
      z.array(z.object({ type: z.string(), text: z.string().optional() })),
    ]),
  }),
})

function reply(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

// Speaker-labelled plain text from a session's JSONL. Reading raw JSONL would
// spend the whole char budget on tool payloads and base64, so the signal is
// pulled out first; a file we cannot read this way yields '' and is refused.
export function extractTranscript(raw: string): string {
  const lines: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const parsed = transcriptRowSchema.safeParse(row)
    if (!parsed.success) continue
    const { role, content } = parsed.data.message
    const text =
      typeof content === 'string'
        ? content
        : content
            .filter((block) => block.type === 'text' && block.text !== undefined)
            .map((block) => block.text)
            .join('\n')
    if (text.trim()) lines.push(`${role}: ${text.trim()}`)
  }
  return lines.join('\n')
}

export function ccTools(root: string, finish: (result: ProfileBootstrap) => void): TaskTool[] {
  // The one realpath the sandbox is measured against. An unresolvable root
  // means there is nothing to read — every tool then degrades to "empty".
  let realRoot: string | null = null
  try {
    realRoot = realpathSync(root)
  } catch {
    realRoot = null
  }

  // True only for a path whose FULLY RESOLVED form sits under the resolved
  // root — which is what makes a symlink out of the tree unreachable.
  function resolveInside(path: string): string | null {
    if (realRoot === null) return null
    let real: string
    try {
      real = realpathSync(path)
    } catch {
      return null
    }
    return real === realRoot || real.startsWith(realRoot + sep) ? real : null
  }

  // id -> resolved path, minted by list_sessions. read_session accepts nothing
  // else, so the model can never name a file murmur did not offer it.
  const minted = new Map<string, string>()

  const listSessions = tool(
    'list_sessions',
    'List the most recent Claude Code sessions on this machine: project, ' +
      'opaque session id, last modified and size. Metadata only — nothing is ' +
      'read until you ask for a session.',
    {},
    async () => {
      const projects = realRoot === null ? null : resolveInside(join(realRoot, 'projects'))
      if (projects === null) return reply({ sessions: [] })

      const found: { path: string; project: string; mtime: number; bytes: number }[] = []
      for (const project of readdirSync(projects, { withFileTypes: true })) {
        if (!project.isDirectory()) continue
        const dir = join(projects, project.name)
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.jsonl')) continue
          const path = resolveInside(join(dir, name))
          if (path === null) continue // symlinked out of the root
          const stat = statSync(path)
          found.push({ path, project: project.name, mtime: stat.mtimeMs, bytes: stat.size })
        }
      }
      found.sort((a, b) => b.mtime - a.mtime)

      // Metadata only: nothing here opens a session file. Counting turns would
      // mean reading all MAX_SESSIONS histories in full — synchronously, in the
      // live radio's process — which a large ~/.claude turns into a stall. Size
      // and recency are the signals the task actually picks by.
      const sessions = found.slice(0, MAX_SESSIONS).map((entry, i) => {
        const id = `s${i + 1}`
        minted.set(id, entry.path)
        return {
          id,
          project: entry.project,
          modified: new Date(entry.mtime).toISOString(),
          bytes: entry.bytes,
        }
      })
      return reply({ sessions })
    },
  )

  const readSession = tool(
    'read_session',
    'Read one session transcript by an id from list_sessions.',
    {
      id: z.string().describe('a session id returned by list_sessions'),
      maxChars: z.number().int().positive().optional().describe(`chars to read (max ${MAX_READ_CHARS})`),
    },
    async (args) => {
      const path = minted.get(args.id.trim())
      if (path === undefined) return reply({ ok: false, error: `unknown session id: ${args.id}` })
      // Re-checked at read time, not just at mint time: the file may have been
      // swapped for a symlink in between.
      if (resolveInside(path) === null) return reply({ ok: false, error: 'session is outside the data root' })

      const cap = Math.min(args.maxChars ?? MAX_READ_CHARS, MAX_READ_CHARS)
      let raw: string
      try {
        raw = readFileSync(path, 'utf-8')
      } catch (err) {
        return reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      // No raw-JSONL fallback: a file the extractor cannot read is a file whose
      // tool outputs, pasted buffers and base64 we would be shipping wholesale
      // to Claude. The consented read is the SPEAKING TURNS, or nothing.
      const full = extractTranscript(raw)
      if (full === '') return reply({ ok: false, error: 'no readable transcript in that session' })
      return reply({ ok: true, id: args.id, text: full.slice(0, cap), truncated: full.length > cap })
    },
  )

  const readInstructions = tool(
    'read_instructions',
    "Read the user's global Claude Code instructions file (CLAUDE.md), if present.",
    {},
    async () => {
      const path = realRoot === null ? null : resolveInside(join(realRoot, 'CLAUDE.md'))
      if (path === null) return reply({ ok: false, error: 'no CLAUDE.md in the data root' })
      try {
        return reply({ ok: true, text: readFileSync(path, 'utf-8').slice(0, MAX_READ_CHARS) })
      } catch (err) {
        return reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  const submitProfile = tool(
    'submit_profile',
    'Finish: submit the initial listener profile as plain text. Ends the task.',
    { profile: z.string().describe('the listener profile, both sections, plain text') },
    async (args) => {
      const profile = args.profile.trim()
      if (!profile) return reply({ ok: false, error: 'submit_profile requires a non-empty profile' })
      const capped = profile.slice(0, PROFILE_CHAR_CAP)
      finish({ profile: capped })
      return reply({ ok: true, chars: capped.length })
    },
  )

  return [listSessions, readSession, readInstructions, submitProfile]
}
