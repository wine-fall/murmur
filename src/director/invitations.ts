// Invitations (spec 14 §2.7/§3.8): the one light form in which the radio ever
// suggests a side-errand. A row is `command - why`, context-gated and fading
// — /sources only while nothing is mounted, /bug only once something has
// aired, /feature-request only after the session has had time to want one —
// and a command that was used leaves the set. Login is never required; this
// is the whole nudge. Pure: the Director sends the result whenever it changes.

import { COMMANDS, type Invitation } from '../host/ipc.ts'
import type { SourceId } from '../music/sources/taste.ts'

export type { Invitation }

type InvitedCommand = Invitation['command']

export type InvitationState = {
  readonly segmentsAired: number
  readonly sessionStartedAt: Date
  readonly mounted: readonly SourceId[]
  readonly filed: readonly ('bug' | 'feature')[]
}

export const FEATURE_INVITE_AFTER_MS = 10 * 60_000

function why(command: InvitedCommand): string {
  return COMMANDS.find((c) => c.name === command)!.blurb
}

export function dueInvitations(state: InvitationState, now: Date, featureAfterMs = FEATURE_INVITE_AFTER_MS): Invitation[] {
  const rows: Invitation[] = []
  if (state.mounted.length === 0) rows.push({ command: '/sources', why: why('/sources') })
  if (state.segmentsAired > 0 && !state.filed.includes('bug')) rows.push({ command: '/bug', why: why('/bug') })
  if (now.getTime() - state.sessionStartedAt.getTime() >= featureAfterMs && !state.filed.includes('feature')) {
    rows.push({ command: '/feature-request', why: why('/feature-request') })
  }
  return rows
}
