// The Director's agentic reply turn (spec 11 §2.3) on fakes: the steer task is
// preferred over the tool-less respond, switch_music hands the air over when
// the fresh pick resolves (never before, never dead air), a hinted request
// re-primes a stale pick, and end_broadcast is two-phase with auto-disarm.
import { describe, expect, it } from 'vitest'

import { EveryNCadence } from '../src/cadence.ts'
import type { ContextPack, SteerActions, SteerBrain } from '../src/contracts.ts'
import { Director, type DirectorDeps, steerFromLine } from '../src/director.ts'
import { COMMANDS } from '../src/ipc.ts'
import { InProcessMemoryStore } from '../src/memory.ts'
import {
  directorSettings,
  FakeBrain,
  FakeHost,
  FakeMixingPlayer,
  FakeMusicHandle,
  FakeTrackSource,
  FakeVoice,
  pickOf,
  until,
} from './fakes.ts'

// Scripts the agentic reply the way the model would: acts through the handed
// actions, then returns the reply text (null = no terminal call). An async
// script stands in for a task still running after its compose was discarded.
class FakeSteer implements SteerBrain {
  calls: { userText: string; armed: boolean }[] = []
  private script: (userText: string, actions: SteerActions) => string | null | Promise<string | null>

  constructor(script: (userText: string, actions: SteerActions) => string | null | Promise<string | null>) {
    this.script = script
  }

  async respond(userText: string, _ctx: ContextPack, actions: SteerActions): Promise<string | null> {
    this.calls.push({ userText, armed: actions.shutdown.armed() })
    return this.script(userText, actions)
  }
}

function build(steer: SteerBrain, opts: { music?: boolean } = {}) {
  const brain = new FakeBrain()
  brain.batches = Array.from({ length: 12 }, (_, i) => [`talk ${2 * i + 1}`, `talk ${2 * i + 2}`])
  const voice = new FakeVoice()
  const player = new FakeMixingPlayer()
  const host = new FakeHost()
  const source = new FakeTrackSource()
  const memory = new InProcessMemoryStore()
  const deps: DirectorDeps = {
    persona: 'persona',
    brain,
    voice,
    player,
    memory,
    host,
    // Injected like every other harness: the Director has no default opener,
    // so a browser can never be launched from a test.
    openUrl: () => {},
    settings: () => directorSettings({ recentWindow: 6 }),
    ...(opts.music !== false && {
      music: { source, cadence: new EveryNCadence(1), engine: player },
    }),
    steer,
  }
  return { deps, brain, voice, player, host, source, memory, director: new Director(deps) }
}

describe('the command grammar', () => {
  it('every entry of the shared COMMANDS list parses as a command, not talk-back', () => {
    // COMMANDS is what the front-ends hint from (spec 10 §3.2-C): a list entry
    // the parser would hand to the Brain as a sentence is a lie on screen.
    for (const command of COMMANDS) {
      expect(steerFromLine(command.name).intent, command.name).not.toBe('talkback')
    }
  })

  it('each command keeps its own meaning regardless of list order (codex review)', () => {
    expect(steerFromLine('/quit').intent).toBe('quit')
    expect(steerFromLine('/settings').intent).toBe('settings')
  })

  it('lists the feedback commands ahead of /quit (harmless-first menu order)', () => {
    const names = COMMANDS.map((command) => command.name)
    expect(names).toContain('/bug')
    expect(names).toContain('/feature-request')
    expect(names.indexOf('/bug')).toBeLessThan(names.indexOf('/quit'))
    expect(names.indexOf('/feature-request')).toBeLessThan(names.indexOf('/quit'))
    expect(names).toContain('/update')
    expect(names.indexOf('/update')).toBeLessThan(names.indexOf('/quit'))
  })
})

describe('commands short-circuit line-blind waits (user report: /quit waited out a spinning stream)', () => {
  const echo = () => new FakeSteer((t) => `re:${t}`)

  it('a /quit typed during a cold talk compose stops without waiting the compose out', async () => {
    const { director, brain, host } = build(echo(), { music: false })
    brain.nextTalksDelayMs = 3000
    host.type('/quit')
    const t = performance.now()
    await director.run()
    expect(performance.now() - t).toBeLessThan(1000)
    expect(host.radio).toEqual([])
  })

  it('a /quit typed while a stream spins up stops now and cuts the stream when it lands', async () => {
    const { director, player, host, source, memory } = build(echo())
    const handle = new FakeMusicHandle()
    handle.startDelayMs = 800
    player.nextHandles = [handle]
    source.picks = [pickOf('https://stream/slow', { title: 'Slow', announce: 'up next' })]
    const run = director.run(2) // talk, then music
    await until(() => player.handles.length === 1, 'stream spinning up')
    const t = performance.now()
    host.type('/quit')
    await run
    expect(performance.now() - t).toBeLessThan(500)
    // Quit reading as "music failed" must not buy one more talk segment
    // (codex review): the first talk is the only thing that ever aired.
    expect(host.radio).toEqual(['talk 1'])
    // The abandoned start is not leaked: the track is cut the moment it lands,
    // and the void start announces nothing and ledgers nothing (codex review).
    await until(() => handle.stopped, 'abandoned stream cut on arrival')
    expect(host.infos.some((m) => m.includes('now playing'))).toBe(false)
    expect(memory.recentSongs(10)).toEqual([])
  })

  it('a /settings typed during a cold compose opens the pane now; the compose still airs', async () => {
    const opened: number[] = []
    const { director, brain, host } = build(echo(), { music: false })
    host.showSettings = () => opened.push(1)
    brain.nextTalksDelayMs = 150
    host.type('/settings')
    const run = director.run(1)
    await until(() => opened.length === 1, 'pane opened mid-compose')
    expect(host.radio).toEqual([]) // the pane did not wait for the compose
    await run
    expect(host.radio).toContain('talk 1')
    expect(host.user).toEqual([]) // a command is never a turn
  })

  it('talk-back typed during a cold compose stays queued for the on-air race', async () => {
    const { director, brain, host } = build(echo(), { music: false })
    brain.nextTalksDelayMs = 100
    host.type('hello there')
    await director.run(1)
    expect(host.user).toContain('hello there')
  })
})

describe('the agentic reply path', () => {
  it('airs the steer task reply; the tool-less respond stays cold', async () => {
    const steer = new FakeSteer(() => 'right here, switching gears.')
    const { director, host, brain } = build(steer, { music: false })
    host.type('hey')
    await director.run(2)
    expect(host.radio).toContain('right here, switching gears.')
    expect(brain.respondCalls).toEqual([])
    expect(steer.calls.map((c) => c.userText)).toEqual(['hey'])
  })

  it('falls back to the tool-less respond when the task never finishes', async () => {
    const steer = new FakeSteer(() => null)
    const { director, host, brain } = build(steer, { music: false })
    host.type('hey')
    await director.run(2)
    expect(brain.respondCalls).toEqual(['hey'])
    expect(host.radio).toContain('re:hey')
  })
})

describe('switch_music: handover on resolve (spec 11 §2.3)', () => {
  it('cuts the old track only when the fresh pick lands, then announces the new one', async () => {
    const steer = new FakeSteer((_text, actions) => {
      actions.music!.switchTrack('softer')
      return 'on it, hang tight.'
    })
    const { director, host, player, source } = build(steer)
    source.picks = [
      pickOf('https://stream/a', { title: 'First' }),
      pickOf('https://stream/b', { title: 'Second', announce: 'here is something softer' }),
    ]
    const run = director.run(2) // talk, then music
    await until(() => player.handles.length === 1, 'first song on air')
    source.delayMs = 60 // the fresh pick takes a moment: reply must not wait for it
    host.type('change the music')
    await until(() => host.radio.includes('on it, hang tight.'), 'reply aired')
    // the reply aired while the old track was still playing (never dead air)
    expect(player.handles[0]!.stopped).toBe(false)
    await until(() => player.handles.length === 2, 'handover to the new track')
    expect(player.handles[0]!.stopped).toBe(true) // cut by the swap, not by the reply
    expect(host.infos.some((m) => m.includes('now playing: Second'))).toBe(true)
    await until(() => host.radio.includes('here is something softer'), 'announce aired')
    expect(host.debugs).toContain('music.switch due')
    expect(host.debugs).toContain('music.switch handover')
    player.handles[1]!.end()
    await run
  })

  it('keeps the old track playing when the switch pick comes back empty', async () => {
    const steer = new FakeSteer((_text, actions) => {
      actions.music!.switchTrack()
      return 'let me find something.'
    })
    const { director, host, player, source } = build(steer)
    source.picks = [pickOf('https://stream/a', { title: 'Only' })] // nothing left to switch to
    const run = director.run(2)
    await until(() => player.handles.length === 1, 'song on air')
    host.type('change it')
    await until(() => host.debugs.includes('music.switch failed'), 'switch gave up')
    expect(player.handles[0]!.stopped).toBe(false) // the old track plays on
    expect(player.handles.length).toBe(1)
    player.handles[0]!.end()
    await run
  })

  it('a hinted request discards a pick primed before the turn and re-primes with the request', async () => {
    const steer = new FakeSteer((_text, actions) => {
      actions.music!.switchTrack('rainy jazz')
      return 'good call.'
    })
    const { director, host, source } = build(steer)
    source.delayMs = 300 // the startup prime is still in flight when the turn lands
    host.type('put on some rainy jazz')
    await director.run(2)
    expect(source.calls).toBe(2) // stale prime discarded, fresh one fired
    expect(source.contexts[1]!.situation).toContain('- listener request: rainy jazz')
  })

  it('with no track playing, the switch forces the next boundary to music past the cadence', async () => {
    const steer = new FakeSteer((_text, actions) => {
      actions.music!.switchTrack()
      return 'coming up.'
    })
    const { director, deps, host, player, source } = build(steer)
    // a cadence that would never choose music on its own
    deps.music!.cadence = new EveryNCadence(99)
    source.picks = [pickOf('https://stream/c', { title: 'Forced' })]
    host.type('play something')
    const run = director.run(3)
    await until(() => player.handles.length === 1, 'forced music boundary aired')
    expect(host.debugs).toContain('music.switch due')
    player.handles[0]!.end()
    await run
  })
})

describe('end_broadcast: two-phase shutdown (spec 11 §2.1)', () => {
  const script = (text: string, actions: SteerActions): string => {
    if (text === 'turn it off') {
      actions.shutdown.arm()
      return 'want me to close up for the night?'
    }
    if (text === 'yes close it') {
      actions.shutdown.confirm()
      return 'goodnight then.'
    }
    return 'staying on.'
  }

  it('arms on the first ask, closes only after the confirming turn', async () => {
    const steer = new FakeSteer(script)
    const { director, host } = build(steer, { music: false })
    host.type('turn it off')
    const run = director.run(20) // resolves long before 20 segments: the confirm quits
    // Type the confirmation only after the question aired — two lines at once
    // would merge into one reply (spec 01 §3.3).
    await until(() => host.radio.includes('want me to close up for the night?'), 'confirm question')
    host.type('yes close it')
    await run
    expect(host.radio).toContain('goodnight then.')
    expect(steer.calls.map((c) => c.armed)).toEqual([false, true])
    // the radio actually stopped: far fewer than 20 talk segments aired
    expect(host.radio.filter((t) => t.startsWith('talk')).length).toBeLessThan(6)
  })

  it('a discarded compose attempt cannot act: its late tool calls are dead', async () => {
    // A merged reply (spec 01 §3.3) discards the in-flight steer task, but the
    // task cannot be cancelled — a late end_broadcast from it must not close
    // the radio the merged reply just promised to keep on.
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const steer = new FakeSteer(async (text, actions) => {
      if (text === 'close it now') {
        await gate // still running when the next line discards this attempt
        actions.shutdown.confirm()
        return 'goodnight.'
      }
      return 'staying on.'
    })
    const { director, host } = build(steer, { music: false })
    host.type('close it now')
    const run = director.run(6)
    await until(() => steer.calls.length === 1, 'first attempt in flight')
    host.type('actually never mind') // merges: the first attempt is discarded
    await until(() => host.radio.includes('staying on.'), 'merged reply aired')
    release() // the orphaned task now fires confirm — into a dead surface
    await run // completes all 6 segments: the radio did NOT quit
    expect(host.radio).not.toContain('goodnight.')
    expect(host.radio.filter((t) => t.startsWith('talk')).length).toBeGreaterThanOrEqual(5)
  })

  it('a non-confirming turn disarms; the next ask must re-arm', async () => {
    const steer = new FakeSteer(script)
    const { director, host } = build(steer, { music: false })
    host.type('turn it off')
    const run = director.run(20)
    await until(() => steer.calls.length === 1, 'first ask handled')
    host.type('never mind, keep playing')
    await until(() => steer.calls.length === 2, 'non-confirming turn handled')
    host.type('turn it off')
    await until(() => steer.calls.length === 3, 're-arm turn handled')
    expect(steer.calls.map((c) => c.armed)).toEqual([false, true, false])
    await run
  })
})
