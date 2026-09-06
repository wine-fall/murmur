// Non-interactive dev preflight for `make dev`.
//
// A REPORTER, not a gatekeeper (spec 03-03 §7.1): it names each dependency the
// chosen run mode wants and what murmur will do without it, then exits 0 —
// always. murmur assumes the user has Claude Code, so every gap named here is
// one the app repairs by TALKING to the user (the setup conversation offered at
// startup, or `make setup`), which means the shell must never stand between
// them and the app. The one exception needs no code: without `node` the shell
// cannot run this script at all, and `make dev` stops there (§7.3 criterion 8).
//
//   node scripts/dev-preflight.ts --voice hosted   # remote TTS wanted
//   node scripts/dev-preflight.ts --voice stub     # silent voice
//   node scripts/dev-preflight.ts --no-music       # skip the binary checks
//   node scripts/dev-preflight.ts --plain          # plain front-end, no bun

import { parseArgs } from 'node:util'

import { voiceConfigPath } from '../src/paths.ts'
import {
  preflightBun,
  preflightFfmpeg,
  preflightYtdlp,
  preflightYtdlpFreshness,
} from '../src/setup/startup.ts'
import { readVoiceConfig } from '../src/voice/voice-config.ts'

const OK = '\x1b[32m✓\x1b[0m'
const NO = '\x1b[33m·\x1b[0m'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    voice: { type: 'string' },
    'no-music': { type: 'boolean' },
    plain: { type: 'boolean' },
    tui: { type: 'boolean' },
  },
})
const voice = values.voice ?? 'hosted'
// The TUI is the default front-end (spec 10 §6); --plain is the opt-out.
const wantsTui = values.plain !== true

console.log('preflight:')
// What the session will be missing, in the words the app itself will use.
const gaps: string[] = []

if (values['no-music'] !== true) {
  const [yt, ff, fresh] = await Promise.all([
    preflightYtdlp(),
    preflightFfmpeg(),
    preflightYtdlpFreshness(),
  ])
  const broken: string[] = []
  for (const [name, result] of [
    ['yt-dlp', yt],
    ['ffmpeg', ff],
  ] as const) {
    if (result.ok) console.log(`  ${OK} ${name}`)
    else {
      console.log(`  ${NO} ${name}: ${result.reason}`)
      broken.push(name)
    }
  }
  if (broken.length > 0) gaps.push(`music needs ${broken.join(' + ')} — the session will be talk-only`)
  else if (!fresh.ok) {
    // The binaries work — this is a freshness warning, not a degradation:
    // music keeps playing, but extractors rot (Bilibili breaks first).
    console.log(`  ${NO} yt-dlp freshness: ${fresh.reason}`)
    gaps.push('yt-dlp is stale (Bilibili breaks first as sites change) — an upgrade fixes it')
  }
}

if (wantsTui) {
  const bun = await preflightBun()
  if (bun.ok) console.log(`  ${OK} bun (tui front-end)`)
  else {
    console.log(`  ${NO} bun: ${bun.reason}`)
    gaps.push('the tui front-end needs bun — the plain front-end will be used')
  }
}

if (voice === 'hosted') {
  // The endpoint is proven on the first synth; here we only report whether one
  // is configured at all, from either layer the app reads (spec 03-03 §7.2).
  const url = process.env.MURMUR_TTS_URL?.trim() || (readVoiceConfig(voiceConfigPath())?.ttsUrl ?? '')
  if (url === '') {
    console.log(`  ${NO} voice endpoint: not configured yet`)
    gaps.push('the voice has no endpoint — lines will show as text, silently')
  } else {
    console.log(`  ${OK} hosted voice -> ${url}`)
  }
}

if (gaps.length > 0) {
  console.log('\nmurmur will start anyway, with these gaps:')
  for (const gap of gaps) console.log(`  · ${gap}`)
  console.log('\nit will offer to fix them by talking you through it. You can also run:')
  console.log('  make setup        the whole surface, as a conversation')
  console.log('  make setup-music  just the music binaries')
} else {
  console.log('all set.')
}
