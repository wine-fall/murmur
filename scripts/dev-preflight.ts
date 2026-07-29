// Non-interactive dev preflight for `make dev`.
//
// Reports each dependency the chosen run mode needs, with an actionable fix,
// and exits non-zero when a hard blocker is missing so `make dev` can stop and
// point the developer at the fix (no silent half-starts). It reuses murmur's
// own music preflight probes (spec 03-03) so this and the in-app startup check
// agree.
//
//   node scripts/dev-preflight.ts --voice hosted   # remote TTS wanted
//   node scripts/dev-preflight.ts --voice stub     # silent voice
//   node scripts/dev-preflight.ts --no-music       # skip the binary checks
//   node scripts/dev-preflight.ts --tui            # the spec-10 front-end wanted

import { parseArgs } from 'node:util'

import { preflightBun, preflightFfmpeg, preflightYtdlp } from '../src/startup.ts'

const OK = '\x1b[32m✓\x1b[0m'
const NO = '\x1b[31m✗\x1b[0m'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    voice: { type: 'string' },
    'no-music': { type: 'boolean' },
    tui: { type: 'boolean' },
  },
})
const voice = values.voice ?? 'hosted'

console.log('preflight:')
const fixes: string[] = []

if (values['no-music'] !== true) {
  const [yt, ff] = await Promise.all([preflightYtdlp(), preflightFfmpeg()])
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
  if (broken.length > 0) {
    const joined = broken.join(' ')
    fixes.push(`music needs ${joined}. Fix with:  make setup-music   (or: brew install ${joined})`)
  }
}

// spec 10 §2.2: bun is a provisioned binary. Without it the TUI is simply not
// offered, so asking for it and not having it is a blocker worth naming here.
if (values.tui === true) {
  const bun = await preflightBun()
  if (bun.ok) console.log(`  ${OK} bun (tui front-end)`)
  else {
    console.log(`  ${NO} bun: ${bun.reason}`)
    fixes.push('the tui front-end needs bun:  curl -fsSL https://bun.sh/install | bash')
  }
}

if (voice === 'hosted') {
  // The endpoint is proven on the first synth; here we only catch the obvious
  // misconfiguration (spec 02 §3.6: never a hardcoded URL).
  const url = process.env.MURMUR_TTS_URL?.trim() ?? ''
  if (url === '') {
    console.log(`  ${NO} hosted voice: MURMUR_TTS_URL not set`)
    fixes.push('hosted voice needs an endpoint:  make dev-fishaudio   (or set MURMUR_TTS_URL in .env)')
  } else {
    console.log(`  ${OK} hosted voice -> ${url}`)
  }
}

if (fixes.length > 0) {
  console.log('\nblockers — fix these, or use an escape hatch:')
  for (const fix of fixes) console.log(`  → ${fix}`)
  console.log('  → skip everything (offline):  STUB=1 make dev')
  process.exit(1)
}
console.log('all set.')
