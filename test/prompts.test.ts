import { describe, expect, it } from 'vitest'

import type { ContextPack } from '../src/contracts.ts'
import {
  buildCompactionPrompt,
  buildFixMusicPrompt,
  buildMusicSituation,
  buildNextTalkPrompt,
  buildNextTalksPrompt,
  buildRespondPrompt,
  buildSeedPersonaPrompt,
  BOOTSTRAP_PROFILE_INSTRUCTION,
  FIND_MUSIC_INSTRUCTION,
  GUIDE_PERSONA,
  PERSONA_CHAR_CAP,
  PROFILE_CHAR_CAP,
  SEED_QUESTIONS,
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

  it('renders an avoid list only when there is one', () => {
    expect(buildMusicSituation([], [])).not.toContain('do not repeat')
    const s = buildMusicSituation([], ['Song A -- Label'])
    expect(s).toContain('do not repeat')
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

describe('guide prompts (spec 03-03)', () => {
  it('the persona shapes behavior: investigate, explain plainly, confirm before change', () => {
    expect(GUIDE_PERSONA).toContain('setup assistant')
    expect(GUIDE_PERSONA).toContain('Investigate first')
    expect(GUIDE_PERSONA).toContain('confirm')
    expect(GUIDE_PERSONA).toContain('smallest safe change')
    expect(GUIDE_PERSONA).toContain('never disable certificate verification')
  })

  it('the fix-music task names both binaries and asks to verify both', () => {
    const p = buildFixMusicPrompt({ ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg' })
    expect(p).toContain('`yt-dlp`')
    expect(p).toContain('`ffmpeg`')
    expect(p).toContain('Verify BOTH')
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
    const p = buildSeedPersonaPrompt(answers)
    for (const a of answers) {
      expect(p).toContain(a.question)
      expect(p).toContain(a.answer)
    }
  })

  it('demands a standalone persona, not a summary, and states the cap', () => {
    const p = buildSeedPersonaPrompt(answers)
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
    const p = buildSeedPersonaPrompt([
      { question: 'Q1', answer: 'answered' },
      { question: 'Q2', answer: '   ' },
    ])
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
