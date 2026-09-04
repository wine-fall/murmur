// Isolated-environment smoke for conversational onboarding (spec 03-03 §7).
//
//   node scripts/onboarding-smoke.ts
//
// What makes it a smoke and not a unit test: it runs against a REAL filesystem
// and a REAL sanitized PATH, in a throwaway $MURMUR_HOME, and it spawns the
// actual app. yt-dlp, ffmpeg and bun are genuinely absent — not faked — so the
// probes, the degraded launch, the ledger write and the voice-config write are
// all exercised end to end.
//
// What it deliberately does NOT do: talk to the real Claude Code SDK. The guide
// conversation itself is stochastic and interactive; the full real-SDK new-user
// run is a separate human/dispatcher pass (§5.3's posture). Everything asserted
// here is deterministic.

import { strict as assert } from 'node:assert'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { buildVoice, voiceAfterSetup } from '../src/app.ts'
import { parseCli } from '../src/config.ts'
import type { GuideCapable } from '../src/contracts.ts'
import { runSetup, SETUP_DECLINED, type SetupTargets } from '../src/setup/guide.ts'
import type { Host } from '../src/host/host.ts'
import { HostedVoice } from '../src/voice/hosted-voice.ts'
import { PersistentMemoryStore } from '../src/memory/memory.ts'
import { readVoiceConfig, type VoiceConfig, writeVoiceConfigTool } from '../src/voice/voice-config.ts'

const run = promisify(execFile)
const REPO = join(import.meta.dirname, '..')

// Only node and claude on PATH: every other binary murmur wants is absent for
// real, which is exactly the new-user machine this slice exists for. claude is
// kept because it is the ONE dependency this slice takes as given (spec 03-03
// §7) — the dispatcher's real-SDK pass runs the guide through this same PATH.
function sanitizedPath(): string {
  const dirs = [dirname(process.execPath)]
  // Resolved from the ambient environment, before we narrow anything.
  const found = execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf-8' }).trim()
  if (found === '') throw new Error('no `claude` on PATH')
  dirs.push(dirname(found))
  return dirs.join(':')
}

function fakeHost(lines: string[]): { host: Host; infos: string[] } {
  const infos: string[] = []
  const host: Host = {
    start: () => {},
    peekLine: () => (lines.length > 0 ? Promise.resolve(lines[0]!) : new Promise(() => {})),
    takeLine: () => lines.shift(),
    // stdin closes once the scripted lines are used up: while any remain the
    // reader must take THEM, and any read past them declines rather than hangs.
    eof: () =>
      new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (lines.length === 0) {
            clearInterval(timer)
            resolve()
          }
        }, 5)
        timer.unref()
      }),
    onRadioSegment: () => {},
    onUserLine: () => {},
    info: (m) => void infos.push(m),
    banner: () => {},
  }
  return { host, infos }
}

const home = mkdtempSync(join(tmpdir(), 'murmur-onboarding-'))
const devLog = join(home, 'dev.log')
const PATH = sanitizedPath()

console.log(`murmur home: ${home}`)
console.log(`sanitized PATH: ${PATH}\n`)

// --- 1. the radio launches degraded, and says what it is missing ----------- //

console.log('1. degraded launch (no yt-dlp, no ffmpeg, no bun, no endpoint)')
{
  const { stdout } = await run(
    process.execPath,
    ['src/main.ts', '--brain', 'stub', '--voice', 'hosted', '--no-bed', '--max-segments', '1'],
    {
      cwd: REPO,
      env: { PATH, MURMUR_HOME: home, MURMUR_DEV_LOG: devLog },
      timeout: 120_000,
    },
  )
  // It reached the air at all — the whole point of the preflight demotion.
  assert.match(stdout, /murmur/i, 'the banner never printed: the radio did not launch')

  const log = existsSync(devLog) ? readFileSync(devLog, 'utf-8') : ''
  assert.match(log, /bun/i, 'no bun fallback notice in the dev log')
  assert.match(log, /see the lines|instead of hearing/i, 'no silent-voice notice in the dev log')
  // Exactly one bun notice, not a wall of shell instructions (spec 10 §6).
  const bunLines = log.split('\n').filter((line) => /bun/i.test(line))
  assert.equal(bunLines.length, 1, `expected ONE bun notice, got ${String(bunLines.length)}`)
  console.log('   ok — launched, fell back to plain, voice silent but visible\n')
}

// --- 2. declining writes the tier-3 ledger record ------------------------- //

console.log('2. declining the boot-time offer')
const memoryDir = join(home, 'data', 'memory')
mkdirSync(memoryDir, { recursive: true })
const memory = new PersistentMemoryStore({ dir: memoryDir })

const targets = (over: Partial<SetupTargets> = {}): SetupTargets => ({
  ytdlp: 'yt-dlp',
  ffmpeg: 'ffmpeg',
  bunCmd: 'bun',
  home,
  wantsMusic: true,
  wantsBun: true,
  wantsVoice: true,
  voiceUrl: () => readVoiceConfig(join(home, 'voice.json'))?.ttsUrl ?? '',
  voiceConfig: () => readVoiceConfig(join(home, 'voice.json')),
  ...over,
})

const neverRuns: GuideCapable = {
  runGuide: () => {
    throw new Error('the guide ran when it should not have')
  },
}

// The probes run for real against the sanitized PATH.
process.env.PATH = PATH
{
  const { host, infos } = fakeHost(['n'])
  const outcome = await runSetup({ host, guide: neverRuns, targets: targets(), ledger: memory })
  assert.equal(outcome.musicOk, false)
  assert.equal(outcome.voiceOk, false)
  assert.ok(
    infos.some((line) => /yt-dlp|music/i.test(line)),
    'the gaps were never named in plain language',
  )

  const ledger = readFileSync(join(memoryDir, 'ledger.jsonl'), 'utf-8')
  const rows = ledger
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; key: string })
  const declined = rows.filter((row) => row.kind === 'setup' && row.key === SETUP_DECLINED)
  assert.equal(declined.length, 1, 'expected exactly one setup.declined row on the ledger')
  console.log('   ok — gaps named, decline recorded on the tier-3 ledger\n')
}

// --- 3. the next boot is quiet: ONE line, no question --------------------- //

console.log('3. the next boot with the same gaps')
{
  // A store re-opened from disk, so this reads the RECORD, not the memory of
  // having written it.
  const reopened = new PersistentMemoryStore({ dir: memoryDir })
  // No scripted lines: if it asked anything, the read would hang and time out.
  const { host, infos } = fakeHost([])
  await runSetup({ host, guide: neverRuns, targets: targets(), ledger: reopened })
  // The probes' loading notice, then exactly one pointer — no question.
  assert.equal(infos.length, 2, `expected the checking notice + ONE quiet line, got ${String(infos.length)}`)
  assert.match(infos[0]!, /checking/, 'the probes ran without their loading notice')
  assert.match(infos[1]!, /make setup/, 'the quiet line does not say how to reopen setup')
  // Parity with the offer itself (issue #93): every gap it named is named
  // again here, the voice included — a quiet line that quietly drops one is
  // how the voice gap went unnoticed in the first place.
  for (const gap of ['yt-dlp|music', 'bun', 'voice']) {
    assert.match(infos[1]!, new RegExp(gap, 'i'), `the quiet line omits the ${gap} gap`)
  }
  console.log(`   ok — one line: "${infos[1]!}"\n`)
}

// --- 4. the voice config the conversation writes -------------------------- //

console.log('4. write_voice_config: validated, scoped, and read back by the app')
{
  let synths = 0
  const tool = writeVoiceConfigTool({
    home,
    validate: async () => void synths++,
  })

  // A dead endpoint writes nothing.
  const failing = writeVoiceConfigTool({
    home,
    validate: () => Promise.reject(new Error('connect ECONNREFUSED')),
  })
  await failing.handler({ ttsUrl: 'https://dead.example' }, {})
  assert.equal(readVoiceConfig(join(home, 'voice.json')), null, 'a failed validation wrote a config')

  // A live one is validated once, then written.
  await tool.handler({ ttsUrl: 'https://tts.example', seed: 42 }, {})
  assert.equal(synths, 1, 'the endpoint was not proven by exactly one synth')
  const saved = readVoiceConfig(join(home, 'voice.json'))
  assert.deepEqual(saved, { ttsUrl: 'https://tts.example', seed: 42 })

  // The app reads it back through the ordinary config path...
  const fromFile = parseCli([], { MURMUR_HOME: home }).config
  assert.equal(fromFile.ttsUrl, 'https://tts.example')
  assert.equal(fromFile.ttsSeed, 42)

  // ...and env still beats it, so .env stays a dev-time override.
  const fromEnv = parseCli([], { MURMUR_HOME: home, MURMUR_TTS_URL: 'https://env.example' }).config
  assert.equal(fromEnv.ttsUrl, 'https://env.example')
  assert.equal(fromEnv.ttsSeed, 42, 'a knob env did not state should still come from the file')

  // Nothing was written outside the one scoped path.
  assert.ok(!existsSync(join(home, '.env')), 'the app wrote a .env — it must never do that')
  console.log('   ok — validated before writing, read back, env still wins\n')
}

// --- 5. a session with nothing missing says nothing ------------------------ //

console.log('5. no gaps, no offer')
{
  const { host, infos } = fakeHost([])
  const outcome = await runSetup({
    host,
    guide: neverRuns,
    targets: targets({ wantsMusic: false, wantsBun: false }),
    ledger: memory,
  })
  // The probes' loading notice is the only thing said — no offer, no pointer.
  assert.equal(infos.length, 1, 'it spoke up with nothing to fix')
  assert.match(infos[0]!, /checking/, 'the one line is not the loading notice')
  assert.equal(outcome.voiceOk, true)
  console.log('   ok — silent beyond the loading notice\n')
}

// --- 6. the hosted (fish.audio) shape: key, model, and same-boot pickup ---- //

console.log('6. a hosted endpoint configured by conversation (issue #96)')
{
  const secret = 'sk-smoke-not-a-real-key'
  // 'y' takes the offer; the key is the next line the user types — and it is
  // the TOOL that reads it, through the same Host the conversation uses.
  const { host, infos } = fakeHost(['y', secret])
  const probed: VoiceConfig[] = []
  const guide: GuideCapable = {
    runGuide: async (req) => {
      const tool = req.tools?.[0]
      assert.ok(tool !== undefined, 'the voice gap got no write tool')
      const result = await tool.handler(
        { ttsUrl: 'https://api.fish.audio', model: 's2.1-pro-free', needsApiKey: true },
        {},
      )
      const block = result.content[0]
      assert.ok(block !== undefined && block.type === 'text', 'the tool returned no text')
      // What goes BACK to the model carries the fact, never the credential.
      assert.ok(!block.text.includes(secret), 'the tool handed the key back to the model')
      return 'done'
    },
  }
  // Its own home: this is a brand-new user, so the voice gap has to be real.
  const fresh = mkdtempSync(join(tmpdir(), 'murmur-onboarding-hosted-'))
  await runSetup({
    host,
    guide,
    targets: targets({
      home: fresh,
      wantsMusic: false,
      wantsBun: false,
      voiceUrl: () => readVoiceConfig(join(fresh, 'voice.json'))?.ttsUrl ?? '',
      voiceConfig: () => readVoiceConfig(join(fresh, 'voice.json')),
    }),
    validateVoice: async (config) => void probed.push(config),
  })

  assert.equal(probed[0]?.apiKey, secret, 'the probe synth went out without the key')
  assert.equal(probed[0]?.model, 's2.1-pro-free', 'the probe synth went out without the model')
  const saved = readVoiceConfig(join(fresh, 'voice.json'))
  assert.equal(saved?.apiKey, secret, 'the key never reached the config file')
  assert.equal(statSync(join(fresh, 'voice.json')).mode & 0o777, 0o600, 'the config is not owner-only')
  assert.ok(
    !infos.some((line) => line.includes(secret)),
    'murmur printed the key',
  )

  // And the run wires itself from it THIS boot, not the next one.
  const resolved = voiceAfterSetup(parseCli([], { MURMUR_HOME: fresh }).config, saved)
  assert.equal(resolved.voice, 'hosted')
  assert.equal(resolved.ttsApiKey, secret)
  assert.equal(resolved.ttsModel, 's2.1-pro-free')
  assert.ok(buildVoice(resolved) instanceof HostedVoice, 'the hosted voice was not built')
  console.log('   ok — key captured off-conversation, file owner-only, voice live this boot\n')
}

console.log(`all onboarding smoke assertions passed.\nartifacts left in ${home}`)
