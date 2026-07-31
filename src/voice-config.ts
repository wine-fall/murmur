// The guide-written voice endpoint (spec 03-03 §7.2).
//
// murmur assumes the user has Claude Code, so a missing voice endpoint is fixed
// by TALKING to murmur rather than by editing a dotfile: the setup conversation
// asks where the endpoint comes from, the user pastes it, and this module's
// tool proves it works — by synthesizing ONE real line through it — before a
// single byte lands on disk.
//
// Two boundaries meet here, so both are enforced locally rather than trusted:
// the file is zod-parsed on every read (hand-edited, torn, or from another
// murmur version), and the write is realpath-scoped to exactly one path inside
// the murmur home (the spec 06 slice-B posture — the write is murmur's, not the
// SDK's, precisely so that scope is enforceable).
//
// `.env` stays a dev-time override the app NEVER writes; env beats this file.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type { TaskTool } from './contracts.ts'

export const VOICE_CONFIG_FILE = 'voice.json'

// What the validation synth says. Short on purpose: it is a proof of life on
// the endpoint, and the user pays for every token of it.
export const VOICE_PROBE_LINE = 'Radio check.'

// An empty url is not a configured endpoint — it is the absence of one, and
// must read as "still a gap" rather than as a config that silently does nothing.
export const VoiceConfigSchema = z.object({
  ttsUrl: z.string().trim().min(1),
  seed: z.coerce.number().int().nonnegative().optional(),
})

export type VoiceConfig = z.infer<typeof VoiceConfigSchema>

// null = no usable config. A damaged file degrades the voice, never boot.
export function readVoiceConfig(path: string): VoiceConfig | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const config = VoiceConfigSchema.safeParse(parsed)
  return config.success ? config.data : null
}

// Temp file + rename in the same directory — the spec 05 §3.1 write discipline,
// so a reader never sees a torn config.
export function writeVoiceConfig(path: string, config: VoiceConfig): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
  renameSync(tmp, path)
}

// The ONE path the setup conversation may write, or null if it cannot be
// resolved safely. The home itself is resolved with realpath (relocating
// ~/.murmur with a symlink is normal), but a symlink planted AT voice.json is
// refused — that is the case where a write inside the home would land outside it.
export function resolveVoiceConfigTarget(home: string): string | null {
  let realHome: string
  try {
    mkdirSync(home, { recursive: true })
    realHome = realpathSync(home)
  } catch {
    return null
  }
  const target = join(realHome, VOICE_CONFIG_FILE)
  if (existsSync(target)) {
    try {
      if (realpathSync(target) !== target) return null
    } catch {
      return null
    }
  }
  return target
}

export type WriteVoiceConfigDeps = {
  // The murmur home; the tool derives the single writable path from it.
  home: string
  // Prove the endpoint by synthesizing one real line. Throws to reject.
  validate: (config: VoiceConfig) => Promise<void>
  // Fired only after a validated config has actually landed on disk.
  onWritten?: (config: VoiceConfig) => void
}

function reply(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

// The ONE murmur-owned tool the setup conversation gets beyond the SDK
// built-ins (spec 03-03 §7.2). It takes no path: the destination is closure-
// bound, so the model can never name a file murmur did not offer it.
export function writeVoiceConfigTool(deps: WriteVoiceConfigDeps): TaskTool {
  return tool(
    'write_voice_config',
    "Save murmur's voice endpoint. Validates it first by synthesizing one real " +
      'line through it; nothing is written if that fails. This is the only way ' +
      'to set the endpoint — never edit .env or any other file for it.',
    {
      ttsUrl: z.string().describe('the TTS endpoint base URL the user gave you'),
      seed: z.coerce
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('optional voice seed, only if the user asked for a specific one'),
    },
    async (args) => {
      const parsed = VoiceConfigSchema.safeParse(args)
      if (!parsed.success) {
        return reply({ ok: false, error: 'a non-empty ttsUrl is required' })
      }
      // Resolved BEFORE the synth: an endpoint we could never persist is not
      // worth spending a real TTS call on.
      const target = resolveVoiceConfigTarget(deps.home)
      if (target === null) {
        return reply({ ok: false, error: 'the voice config path is not writable safely' })
      }
      try {
        await deps.validate(parsed.data)
      } catch (err) {
        return reply({
          ok: false,
          error: `the endpoint did not answer: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
      try {
        writeVoiceConfig(target, parsed.data)
      } catch (err) {
        return reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      deps.onWritten?.(parsed.data)
      return reply({ ok: true, path: target })
    },
  )
}
