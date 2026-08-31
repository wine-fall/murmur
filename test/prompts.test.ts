import { describe, expect, it } from 'vitest'

import type { ContextPack } from '../src/contracts.ts'
import {
  ACTIVITY_GUIDANCE,
  buildCompactionPrompt,
  buildFixMusicPrompt,
  buildMusicSituation,
  buildNextTalkPrompt,
  buildNextTalksPrompt,
  buildRespondPrompt,
  buildSeedPersonaPrompt,
  buildSetupPrompt,
  VISIT_PERSONA,
  buildSteerPrompt,
  BOOTSTRAP_PROFILE_INSTRUCTION,
  CUE_GUIDANCE,
  buildFindMusicInstruction,
  DEFAULT_MUSIC_POLICY,
  FIND_MUSIC_INSTRUCTION,
  GUIDE_PERSONA,
  PERSONA_CHAR_CAP,
  PROFILE_CHAR_CAP,
  SEED_QUESTIONS,
  STATUS_MICROCOPY,
  statusMicrocopy,
  withLanguage,
} from '../src/prompts.ts'

const ctx = (recent: ContextPack['recent']): ContextPack => ({ persona: 'p', recent })

describe('prompt builders', () => {
  it('opens naturally with an empty transcript', () => {
    const p = buildNextTalkPrompt(ctx([]))
    expect(p).toContain('just starting')
    expect(p).not.toContain('The program so far')
  })

  it('renders the transcript with You/Listener speakers', () => {
    const p = buildNextTalkPrompt(
      ctx([
        { role: 'radio', text: 'hello there' },
        { role: 'user', text: 'hi back' },
      ]),
    )
    expect(p).toContain('You: hello there')
    expect(p).toContain('Listener: hi back')
  })

  it('batched prompt names the tool and the count', () => {
    const p = buildNextTalksPrompt(ctx([]), 3)
    expect(p).toContain('emit_talk_beats')
    expect(p).toContain('3 beats')
  })

  it('respond prompt quotes the user line and drops its trailing echo', () => {
    const p = buildRespondPrompt('what time is it', ctx([{ role: 'user', text: 'what time is it' }]))
    expect(p).toContain('"what time is it"')
    // The trailing user turn is the line being answered; it must not render
    // twice (once in the transcript, once quoted).
    expect(p).not.toContain('Listener: what time is it')
  })
})

describe('music prompts', () => {
  it('instructs the pick task to judge candidates and write the announce', () => {
    expect(FIND_MUSIC_INSTRUCTION).toContain('search_music')
    expect(FIND_MUSIC_INSTRUCTION).toContain('submit_pick')
    expect(FIND_MUSIC_INSTRUCTION).toContain('announce')
    expect(FIND_MUSIC_INSTRUCTION).toContain('Someone has to be singing')
  })

  // spec 03-01 §2.3: the listener owns the taste half, the code owns the
  // contract half. A policy that forgets to ask for an announce must not be
  // able to produce a pick with no announce.
  it('lets a listener policy replace the taste rules but never the contract', () => {
    const mine = '- only cantopop, nothing else'
    const instruction = buildFindMusicInstruction(mine)
    expect(instruction).toContain(mine)
    expect(instruction).not.toContain('Someone has to be singing') // the built-in taste is gone
    expect(instruction).toContain('search_music')
    expect(instruction).toContain('submit_pick')
    expect(instruction).toContain('announce')
  })

  it('falls back to the built-in policy when there is no file', () => {
    expect(buildFindMusicInstruction()).toBe(FIND_MUSIC_INSTRUCTION)
    expect(FIND_MUSIC_INSTRUCTION).toContain(DEFAULT_MUSIC_POLICY)
  })

  // The whole point of the data source (spec 03-01 §2.3): left to its own
  // memory the model plays the same handful of songs forever.
  it('tells the task not to lean on the songs it already remembers', () => {
    expect(DEFAULT_MUSIC_POLICY).toContain('Do not choose out of memory')
  })

  // The default policy is the shipped answer to the habit, so it must name
  // every widening tool that exists -- a doc that drifts behind the tool list
  // silently stops being the playbook it claims to be.
  it('names each widening tool, at both the artist and the song level', () => {
    expect(DEFAULT_MUSIC_POLICY).toContain('similar_music')
    expect(DEFAULT_MUSIC_POLICY).toContain('top_tracks')
    expect(DEFAULT_MUSIC_POLICY).toContain('search_music')
  })

  // Found by smoke, locked here: compressed to a clause inside another step,
  // "someone singing" lost to a solo-piano track that fit the hour. The
  // exclusion has to name what it excludes.
  it('rules out instrumentals by name, in a step of its own', () => {
    expect(DEFAULT_MUSIC_POLICY).toContain('Someone has to be singing')
    for (const trap of ['ambient', 'piano', 'lofi', 'soundtrack']) {
      expect(DEFAULT_MUSIC_POLICY).toContain(trap)
    }
  })

  // A playbook, not a ban list: it has to say what to DO, in order.
  it('reads as ordered steps', () => {
    for (const step of ['1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.']) {
      expect(DEFAULT_MUSIC_POLICY).toContain(step)
    }
  })

  it('renders the recent turns and the music-break intent', () => {
    const s = buildMusicSituation([
      { role: 'radio', text: 'it is quiet tonight' },
      { role: 'user', text: 'play me something' },
    ])
    expect(s).toContain('- You: it is quiet tonight')
    expect(s).toContain('- Listener: play me something')
    expect(s).toContain('Intent: a music break')
  })

  it('says so plainly when the program has just started', () => {
    expect(buildMusicSituation([])).toContain('just started')
  })

  // The situation states facts; the RULE about them lives in the replaceable
  // policy (step 8). Otherwise a listener whose policy welcomes repeats still
  // gets a code-owned "do not repeat" in the same prompt, contradicting them.
  it('renders the recently-played list as a fact, not as an instruction', () => {
    const s = buildMusicSituation([], ['Song A -- Label'])
    expect(s).toContain('Recently played')
    expect(s).toContain('- Song A -- Label')
    expect(s).not.toContain('do not repeat')
    expect(DEFAULT_MUSIC_POLICY).toContain('recently played')
  })

  it('renders an avoid list only when there is one', () => {
    expect(buildMusicSituation([], [])).not.toContain('Recently played')
    const s = buildMusicSituation([], ['Song A -- Label'])
    expect(s).toContain('- Song A -- Label')
  })
})

describe('memory + scene rendering (spec 05 §3.5)', () => {
  it('renders the profile as a stable block ahead of the transcript', () => {
    const p = buildNextTalkPrompt({
      persona: 'p',
      recent: [{ role: 'radio', text: 'hello' }],
      profile: 'likes jazz',
    })
    expect(p).toContain('(What you know about the listener)\nlikes jazz')
    expect(p.indexOf('likes jazz')).toBeLessThan(p.indexOf('The program so far'))
  })

  it('renders the covered-topics do-not-repeat line', () => {
    const p = buildNextTalksPrompt(
      { persona: 'p', recent: [], coveredTopics: ['rain', 'coffee'] },
      2,
    )
    expect(p).toContain('rain, coffee')
    expect(p).toContain("don't repeat")
  })

  it('renders a scene cue for a known bucket', () => {
    const p = buildNextTalkPrompt({ persona: 'p', recent: [], scene: 'late-night' })
    expect(p).toContain('late at night')
  })

  it('empty profile/topics and an unknown scene render nothing', () => {
    const p = buildNextTalkPrompt({
      persona: 'p',
      recent: [],
      profile: '  ',
      coveredTopics: [],
      scene: 'lunar',
    })
    expect(p).not.toContain('What you know about the listener')
    expect(p).not.toContain("don't repeat")
    expect(p).not.toContain('lunar')
  })

  it('the respond prompt carries the profile block too', () => {
    const p = buildRespondPrompt('hey', { persona: 'p', recent: [], profile: 'night owl' })
    expect(p).toContain('(What you know about the listener)\nnight owl')
  })
})

describe('music state + clock grounding (spec 04 bugfix)', () => {
  const base = { persona: 'p', recent: [] }

  it('renders the on-air track', () => {
    const p = buildNextTalkPrompt({ ...base, music: { kind: 'playing', track: 'Song — Artist' } })
    expect(p).toContain('"Song — Artist" is playing right now')
  })

  it('renders the between-songs state with the last track', () => {
    const p = buildNextTalkPrompt({ ...base, music: { kind: 'quiet', lastTrack: 'Song — Artist' } })
    expect(p).toContain('No music is playing')
    expect(p).toContain('the last song was "Song — Artist"')
  })

  it('renders the quiet state before any song has aired', () => {
    const p = buildNextTalkPrompt({ ...base, music: { kind: 'quiet' } })
    expect(p).toContain('No music is playing right now')
    expect(p).not.toContain('last song')
  })

  it('renders the background-search state', () => {
    const p = buildNextTalksPrompt({ ...base, music: { kind: 'picking' } }, 2)
    expect(p).toContain('No music is playing')
    expect(p).toContain('looking for the next track')
  })

  it('renders the failed-search state', () => {
    const p = buildNextTalksPrompt({ ...base, music: { kind: 'pickFailed' } }, 2)
    expect(p).toContain('No music is playing')
    expect(p).toContain('came up empty')
  })

  it('an absent music state renders nothing about music', () => {
    const p = buildNextTalkPrompt(base)
    expect(p).not.toContain('No music')
    expect(p).not.toContain('is playing right now')
  })

  it('renders the real clock alongside the scene cue', () => {
    const p = buildNextTalkPrompt({ ...base, time: '2:28 pm', scene: 'afternoon' })
    expect(p).toContain("It's 2:28 pm")
    expect(p).toContain('afternoon')
  })

  it('an absent time renders no clock line', () => {
    expect(buildNextTalkPrompt(base)).not.toContain("It's ")
  })

  it('the respond and steer prompts carry the same clock and music facts (codex review)', () => {
    const ctx = {
      ...base,
      time: '2:28 pm',
      music: { kind: 'playing', track: 'Song — Artist' },
    } as const
    const prompts = [
      buildRespondPrompt('hey', ctx),
      buildSteerPrompt('hey', ctx, { musicWired: true, shutdownArmed: false, settingsWired: false }),
    ]
    for (const p of prompts) {
      expect(p).toContain("It's 2:28 pm")
      expect(p).toContain('"Song — Artist" is playing right now')
    }
  })

  it('both talk builders carry the anti-fabrication red lines', () => {
    for (const p of [buildNextTalkPrompt(base), buildNextTalksPrompt(base, 2)]) {
      expect(p).toContain('never announce, promise, or narrate')
      expect(p).toContain("sounds from the listener's side")
      expect(p).toContain('never narrate time passing')
    }
  })
})

describe('guide prompts (spec 03-03)', () => {
  it('the persona shapes behavior: authorized to act, conversational stops only at real forks', () => {
    expect(GUIDE_PERSONA).toContain('setup assistant')
    expect(GUIDE_PERSONA).toContain('Investigate first')
    expect(GUIDE_PERSONA).toContain('smallest safe change')
    expect(GUIDE_PERSONA).toContain('never disable certificate verification')
    // The entry authorization (spec 03-03 §3): routine steps run
    // without asking; the checkpoints that remain are conversational and sit
    // on the substantive forks.
    expect(GUIDE_PERSONA).toContain('just do it')
    expect(GUIDE_PERSONA).toContain('destructive')
    expect(GUIDE_PERSONA).toContain('costs money')
    // No per-action consent language left over.
    expect(GUIDE_PERSONA).not.toContain('ALWAYS ask')
    expect(GUIDE_PERSONA).not.toContain('before you make any change')
  })

  it('the persona still refuses to take a credential through the conversation', () => {
    expect(GUIDE_PERSONA.toLowerCase()).toMatch(/never\s+ask the user to type[^.]*(key|password)/)
  })

  it('the fix-music task names both binaries and asks to verify both', () => {
    const p = buildFixMusicPrompt({ ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg' })
    expect(p).toContain('`yt-dlp`')
    expect(p).toContain('`ffmpeg`')
    expect(p).toContain('Verify BOTH')
    // The old per-action gate is gone from the task too: a routine install is
    // carried out, not proposed-and-parked.
    expect(p).not.toContain('WAIT for my go-ahead')
  })

  it('carries the preflight finding as evidence only when there is one', () => {
    const found = buildFixMusicPrompt({
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      reason: 'yt-dlp: binary not found',
    })
    expect(found).toContain('automated check')
    expect(found).toContain('yt-dlp: binary not found')
    const clean = buildFixMusicPrompt({ ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg' })
    expect(clean).not.toContain('automated check')
  })

  it('does not prescribe the remedy: diagnosis is the task', () => {
    // The agent figures out WHY (spec 03-03 §1 non-goal: no prescribed fix).
    const p = buildFixMusicPrompt({ ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg' })
    expect(p).toContain('figure out WHY')
  })
})

describe('compaction prompt', () => {
  it('carries the profile, the transcript, and the size cap', () => {
    const p = buildCompactionPrompt('knows jazz', [
      { role: 'radio', text: 'evening' },
      { role: 'user', text: 'long day' },
    ])
    expect(p).toContain('(Current profile)\nknows jazz')
    expect(p).toContain('radio: evening')
    expect(p).toContain('user: long day')
    expect(p).toContain(String(PROFILE_CHAR_CAP))
  })

  it('placeholders an empty profile and empty transcript', () => {
    const p = buildCompactionPrompt('  ', [])
    expect(p).toContain('(no profile yet)')
    expect(p).toContain('(nothing)')
  })
})

// --- spec 06 ---------------------------------------------------------------- //

describe('seed-persona prompt (spec 06 §2.2/§3.3)', () => {
  const answers = [
    { question: SEED_QUESTIONS[0], answer: 'call me Zach, I code late' },
    { question: SEED_QUESTIONS[1], answer: 'company while I work' },
    { question: SEED_QUESTIONS[2], answer: 'dry and quiet, speak Chinese' },
  ]

  it('asks exactly three questions covering who / what / how', () => {
    expect(SEED_QUESTIONS).toHaveLength(3)
    expect(SEED_QUESTIONS[0]).toMatch(/listening/i)
    expect(SEED_QUESTIONS[1]).toMatch(/on the air/i)
    expect(SEED_QUESTIONS[2]).toMatch(/language/i)
  })

  it('carries every answered question and its answer', () => {
    const p = buildSeedPersonaPrompt(answers, 'English')
    for (const a of answers) {
      expect(p).toContain(a.question)
      expect(p).toContain(a.answer)
    }
  })

  // spec 06 §3.2: what the listener asked for wins; the language they typed in
  // is the next-best read; the detected default only catches the rest.
  it('ranks the language sources and names the detected default', () => {
    const p = buildSeedPersonaPrompt(answers, 'Japanese')
    expect(p).toMatch(/language/i)
    expect(p).toContain('Japanese')
    expect(p).toMatch(/wrote their answers in/i)
    expect(p).toMatch(/state that language explicitly/i)
  })

  it('demands a standalone persona, not a summary, and states the cap', () => {
    const p = buildSeedPersonaPrompt(answers, 'English')
    expect(p).toContain(String(PERSONA_CHAR_CAP))
    expect(p).toMatch(/not a summary/i)
    expect(p).toMatch(/do not invent/i)
    // spec 04 §3.4 supplies the time-of-day cue per call, so the persona must
    // not fix itself to one — a real smoke produced a "late-night host" purely
    // because the listener said they keep late hours.
    expect(p).toMatch(/time-neutral/i)
    expect(p).toMatch(/not.*late-night host/i)
    expect(p).toMatch(/hours they keep/i)
  })

  it('drops skipped questions rather than sending blanks', () => {
    const p = buildSeedPersonaPrompt(
      [
        { question: 'Q1', answer: 'answered' },
        { question: 'Q2', answer: '   ' },
      ],
      'English',
    )
    expect(p).toContain('Q1')
    expect(p).not.toContain('Q2')
  })
})

describe('compaction prompt keeps two sections (spec 06 slice C)', () => {
  it('requests both the listener facts and the relationship section', () => {
    const p = buildCompactionPrompt('x', [])
    expect(p).toContain('(About the listener)')
    expect(p).toContain('(Relationship & style)')
  })

  it('marks the relationship section observational, not directive', () => {
    // The guardrail against persona evolution through the back door (§2.5).
    const p = buildCompactionPrompt('x', [])
    expect(p).toMatch(/observational/i)
    expect(p).toMatch(/persona/i)
  })
})

describe('profile bootstrap prompt (spec 06 slice B)', () => {
  it('names its tools and the same two-section shape compaction maintains', () => {
    expect(BOOTSTRAP_PROFILE_INSTRUCTION).toContain('list_sessions')
    expect(BOOTSTRAP_PROFILE_INSTRUCTION).toContain('read_session')
    expect(BOOTSTRAP_PROFILE_INSTRUCTION).toContain('read_instructions')
    expect(BOOTSTRAP_PROFILE_INSTRUCTION).toContain('submit_profile')
    expect(BOOTSTRAP_PROFILE_INSTRUCTION).toContain('(About the listener)')
    expect(BOOTSTRAP_PROFILE_INSTRUCTION).toContain('(Relationship & style)')
  })

  it('excludes secrets and surveillance-shaped detail', () => {
    expect(BOOTSTRAP_PROFILE_INSTRUCTION).toMatch(/secret|credential/i)
    expect(BOOTSTRAP_PROFILE_INSTRUCTION).toMatch(/surveillance/i)
  })
})

// --- spec 07 ---------------------------------------------------------------- //

describe('pacing cues (spec 07 §2.2/§3.4/§3.5)', () => {
  const pack = (over: Partial<ContextPack>): ContextPack => ({ persona: 'p', recent: [], ...over })

  it('renders an activity cue that adjusts manner without narrating the sensing', () => {
    const quiet = buildNextTalksPrompt(pack({ activity: 'away' }), 2)
    expect(quiet).toContain(ACTIVITY_GUIDANCE.away)
    expect(quiet.toLowerCase()).not.toContain('idle')
    expect(quiet.toLowerCase()).not.toContain('seem to be away')
    expect(buildNextTalksPrompt(pack({ activity: 'engaged' }), 2)).toContain(
      ACTIVITY_GUIDANCE.engaged,
    )
  })

  it('renders nothing for an absent or unknown activity', () => {
    const bare = buildNextTalksPrompt(pack({}), 2)
    for (const cue of Object.values(ACTIVITY_GUIDANCE)) expect(bare).not.toContain(cue)
    // An unmapped value degrades silently, like an unknown scene.
    const odd = buildNextTalksPrompt(pack({ activity: 'asleep' as never }), 2)
    expect(odd).toBe(bare)
  })

  it('renders the per-anchor cue', () => {
    for (const id of ['morning', 'midday', 'night'] as const) {
      const p = buildNextTalksPrompt(pack({ cue: `anchor:${id}` }), 1)
      expect(p).toContain(CUE_GUIDANCE[`anchor:${id}`])
    }
    // Each anchor speaks differently.
    expect(CUE_GUIDANCE['anchor:morning']).not.toBe(CUE_GUIDANCE['anchor:night'])
  })

  it('an unknown cue renders nothing', () => {
    expect(buildNextTalksPrompt(pack({ cue: 'nonsense' }), 2)).toBe(buildNextTalksPrompt(pack({}), 2))
  })

  it('cues reach the single-beat fallback prompt too', () => {
    expect(buildNextTalkPrompt(pack({ cue: 'anchor:night', activity: 'present' }))).toContain(
      CUE_GUIDANCE['anchor:night'],
    )
  })
})

describe('status microcopy (spec 10 §3.7.4)', () => {
  it('speaks in the DJ voice for every program situation', () => {
    for (const pool of Object.values(STATUS_MICROCOPY)) {
      expect(pool.length).toBeGreaterThan(0)
      // Chrome copy, not a loader: no dev-tool vocabulary anywhere in the pool.
      for (const line of pool) expect(line).not.toMatch(/loading|error|status|buffer/i)
    }
  })

  it('draws from the pool that matches what the program is doing', () => {
    for (const kind of ['talk', 'music', 'gap'] as const) {
      const line = statusMicrocopy({ kind })
      expect(STATUS_MICROCOPY[kind]).toContain(line)
    }
  })

  it('costs no tokens — it is a fixed local pool, picked deterministically', () => {
    expect(statusMicrocopy({ kind: 'gap' }, () => 0)).toBe(STATUS_MICROCOPY.gap[0])
    expect(statusMicrocopy({ kind: 'gap' }, () => 0.999)).toBe(STATUS_MICROCOPY.gap.at(-1))
  })
})

// Issue #96: the walkthrough has to take a brand-new user from "no account" to
// an audible line without ever touching a shell — and without murmur claiming
// anything about fish.audio's terms that it has not just checked.
describe('the voice-endpoint walkthrough (spec 03-03 §7.2)', () => {
  const prompt = (): string =>
    buildSetupPrompt({
      gaps: [{ kind: 'voice', reason: 'no endpoint configured' }],
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      bunCmd: 'bun',
    })

  it('caps the live policy check and degrades honestly past it (issue #102)', () => {
    const text = prompt()
    expect(text).toMatch(/at most\s+two/)
    expect(text).toContain('could not check')
  })

  it('walks registration by name: signup, the key page, the model header', () => {
    const text = prompt()
    expect(text).toContain('https://fish.audio/auth/signup')
    expect(text).toContain('https://fish.audio/app/api-keys')
    // The `model` header is required by the hosted API; a config without it
    // cannot validate no matter how good the URL and key are.
    expect(text).toContain('model')
    expect(text).toContain('write_voice_config')
  })

  it('routes the key through the tool, never through the conversation', () => {
    const text = prompt()
    expect(text).toContain('needsApiKey')
    expect(text.toLowerCase()).toMatch(/never ask (them|the user) to (type|paste|send)[^.]*key/)
  })

  it('has the user pick a voice, because a hosted config without one drifts', () => {
    // fish.audio has no default voice identity and ignores `seed`, so
    // reference_id is the only thing that keeps the timbre stable.
    expect(prompt()).toContain('referenceId')
  })

  it("offers murmur's own two voices first, as a preset the tool fetches itself", () => {
    const text = prompt()
    // The listener is told there is a download and an upload before either moves.
    expect(text).toMatch(/preset/)
    expect(text).toMatch(/male/)
    expect(text).toMatch(/female/)
    expect(text).toMatch(/download/i)
    // The presets come before the record-your-own and library options.
    expect(text.indexOf('preset')).toBeLessThan(text.indexOf('a voice of their own'))
  })

  it('states no policy from memory: the free tier is checked live or not claimed', () => {
    const text = prompt()
    expect(text.toLowerCase()).toContain('webfetch')
    // A date in the prompt is a promise that expires silently. There is none:
    // no year, no month name, anywhere in the setup prompt.
    expect(text).not.toMatch(/\b(19|20)\d{2}\b/)
    // ('may' is left out — it is an ordinary English word, and the year guard
    // above is what actually catches a written-out date.)
    expect(text).not.toMatch(
      /\b(january|february|march|april|june|july|august|september|october|november|december)\b/i,
    )
  })
})

// A stale yt-dlp is a different task from a broken install: the binary works,
// so the remedy is an upgrade on whichever channel already owns it, verified
// by re-reading the release date the freshness probe trusts.
describe('the stale-ytdlp task (spec 03-03 §7.1)', () => {
  it('gets an upgrade task: owning channel first, verified by the release date', () => {
    const text = buildSetupPrompt({
      gaps: [{ kind: 'ytdlp', reason: 'yt-dlp 2026.03.01 is 164 days old' }],
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      bunCmd: 'bun',
    })
    // The probe finding seeds the diagnosis, like every other gap.
    expect(text).toContain('164 days old')
    // brew first — the same channel preference the music section states.
    expect(text).toContain('brew upgrade yt-dlp')
    const brewAt = text.indexOf('brew upgrade yt-dlp')
    const uvAt = text.search(/\buv\b|pipx/)
    expect(uvAt).toBeGreaterThan(brewAt)
    // Verified deterministically — the dated release, not a flaky live fetch.
    expect(text).toContain('--version')
  })
})

// spec 12 §3.9: the settings override never edits persona.md. It rides as one
// directive appended to the persona, so clearing it restores the persona's own
// word and a hand-edited persona is never clobbered.
describe('the language override directive (spec 12 §3.9)', () => {
  const persona = '# a night host\n\nAlways speak in English.'

  it('leaves the persona untouched when nothing is set', () => {
    expect(withLanguage(persona, undefined)).toBe(persona)
    expect(withLanguage(persona, '   ')).toBe(persona)
  })

  it('appends a directive that outranks what the persona says', () => {
    const composed = withLanguage(persona, 'Japanese')
    expect(composed.startsWith(persona)).toBe(true)
    expect(composed).toMatch(/Japanese/)
    // It has to win against the persona's own line, or the override is advice.
    expect(composed).toMatch(/persona/i)
  })
})

// codex review: the tool being in the set is not enough — the steer prompt's
// catch-all ("anything else is just conversation, no action tools") actively
// told the model NOT to act on a settings request. Authorization is per
// capability, exactly like switch_music.
describe('the steer prompt authorizes change_settings (spec 12 §2.6)', () => {
  const ctx = { persona: 'p', recent: [] }

  it('names the tool and what earns it, when a store is wired', () => {
    const p = buildSteerPrompt('mute yourself', ctx, {
      musicWired: false,
      shutdownArmed: false,
      settingsWired: true,
    })
    expect(p).toMatch(/change_settings/)
    // The same guard the pane's vocabulary implies: a mood remark is not a request.
    expect(p).toMatch(/not a request/i)
  })

  it('says nothing about it when no store is wired', () => {
    const p = buildSteerPrompt('mute yourself', ctx, {
      musicWired: false,
      shutdownArmed: false,
      settingsWired: false,
    })
    expect(p).not.toMatch(/change_settings/)
  })
})

// A listener who types /setup on a machine with nothing wrong is not asking
// for a diagnosis — they came to change something, and the timbre is what the
// guide itself told them they could settle later (spec 03-03 §7.1).
describe('the healthy-machine setup prompt', () => {
  const text = buildSetupPrompt({ gaps: [], ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', bunCmd: 'bun' })

  it('opens by asking what they came to change, not by hunting for faults', () => {
    expect(text).toMatch(/nothing (is )?(broken|wrong)|everything (checks out|works)/i)
    expect(text).toMatch(/ask|what.*want/i)
    // The failure to design against is a guide that "repairs" a working
    // machine because its prompt handed it a repair task.
    expect(text).not.toContain('the user has said yes to you fixing this')
  })

  it('names the thing they are most likely there for', () => {
    expect(text).toContain('create_voice')
    expect(text).toContain('write_voice_config')
    // Switching to the other bundled timbre is the likeliest change of all.
    expect(text).toMatch(/preset/)
  })
})

// Peer review (codex): the healthy-run prompt was still sent under
// GUIDE_PERSONA, which states the user already said yes to repairs, tells the
// guide to "investigate first", and pre-authorizes routine shell and file
// changes — and cliPermission auto-allows those. A lower-priority "do not run
// diagnostics" line cannot hold against a system prompt saying the opposite.
describe('the persona a setup conversation runs under', () => {
  it('authorizes repairs only when there are repairs', () => {
    expect(GUIDE_PERSONA).toMatch(/already given you the\s+go-ahead|authorized you/i)
    expect(VISIT_PERSONA).not.toMatch(/already given you the\s+go-ahead|authorized you/i)
  })

  it('makes the healthy visit ask before it changes anything', () => {
    expect(VISIT_PERSONA).toMatch(/ask/i)
    expect(VISIT_PERSONA).toMatch(/nothing is broken|nothing to fix|came to change/i)
  })

  it('keeps the credential rule in BOTH — it is not a repair-time rule', () => {
    for (const persona of [GUIDE_PERSONA, VISIT_PERSONA]) {
      expect(persona.toLowerCase()).toContain('api key')
    }
  })
})
