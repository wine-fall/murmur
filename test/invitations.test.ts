// The one light hint form (spec 14 §2.7/§3.8): a pure, context-gated set.
import { describe, expect, it } from 'vitest'

import { dueInvitations, FEATURE_INVITE_AFTER_MS, type InvitationState } from '../src/director/invitations.ts'
import { COMMANDS } from '../src/host/ipc.ts'

const T0 = new Date('2026-09-06T20:00:00Z')
const base: InvitationState = { segmentsAired: 0, sessionStartedAt: T0, mounted: [], filed: [] }
const at = (ms: number): Date => new Date(T0.getTime() + ms)
const names = (state: InvitationState, now: Date = T0): string[] => dueInvitations(state, now).map((i) => i.command)

describe('dueInvitations (spec 14 §5.10 table)', () => {
  it('boot: /sources alone when nothing is mounted; nothing at all when something is', () => {
    expect(names(base)).toEqual(['/sources'])
    expect(names({ ...base, mounted: ['spotify'] })).toEqual([])
  })

  it('after one segment /bug joins; at ten minutes /feature-request joins', () => {
    expect(names({ ...base, segmentsAired: 1 })).toEqual(['/sources', '/bug'])
    expect(names({ ...base, segmentsAired: 1 }, at(FEATURE_INVITE_AFTER_MS - 1))).toEqual(['/sources', '/bug'])
    expect(names({ ...base, segmentsAired: 1 }, at(FEATURE_INVITE_AFTER_MS))).toEqual(['/sources', '/bug', '/feature-request'])
  })

  it('a mount removes /sources; a filing removes its own command for the session', () => {
    const late = at(FEATURE_INVITE_AFTER_MS)
    expect(names({ ...base, segmentsAired: 3, mounted: ['netease'] }, late)).toEqual(['/bug', '/feature-request'])
    expect(names({ ...base, segmentsAired: 3, filed: ['bug'] }, late)).toEqual(['/sources', '/feature-request'])
    expect(names({ ...base, segmentsAired: 3, filed: ['bug', 'feature'] }, late)).toEqual(['/sources'])
  })

  it('an expired mount is still a mount — that case is the §2.6 line, not an invitation', () => {
    expect(names({ ...base, mounted: ['netease'] })).toEqual([])
  })

  it('the why is the command\'s one blurb, and stays under 48 characters', () => {
    const rows = dueInvitations({ ...base, segmentsAired: 1 }, at(FEATURE_INVITE_AFTER_MS))
    for (const row of rows) {
      const command = COMMANDS.find((c) => c.name === row.command)!
      expect(row.why).toBe(command.blurb)
      expect(row.why.length).toBeLessThanOrEqual(48)
    }
    expect(rows.map((r) => r.why)).toEqual([
      'your NetEase or Spotify likes make better picks',
      'something broke? two lines and it\'s filed',
      'wish it did something? say so',
    ])
  })
})
