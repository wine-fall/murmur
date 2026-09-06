// The cadence task (spec 03-02 §2.3, brain mode only): talk or music next.

export const CADENCE_INSTRUCTION = `You are pacing a personal radio program. Decide what the NEXT segment should
be: more talk, or a piece of music.

Think like a radio host: talk builds connection, music gives the listener room
to breathe. Avoid long talk-only stretches and avoid wall-to-wall music.

Call choose_segment exactly once with your decision.`

export const CADENCE_STATE_HEADER = 'Current program state:\n'
