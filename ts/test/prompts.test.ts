import { describe, expect, it } from 'vitest'

import type { ContextPack } from '../src/contracts.ts'
import {
  buildCompactionPrompt,
  buildMusicSituation,
  buildNextTalkPrompt,
  buildNextTalksPrompt,
  buildRespondPrompt,
  FIND_MUSIC_INSTRUCTION,
  PROFILE_CHAR_CAP,
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
