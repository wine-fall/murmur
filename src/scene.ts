// Time-of-day scene derivation (spec 04 §3.4, ratified by spec 05 §2.2).
// sceneFor is pure and clock-free so the boundaries are unit-testable;
// currentScene is the runtime entry: it honors a MURMUR_SCENE override
// (by-ear / testing) and otherwise derives from the supplied clock.

export const SCENES = ['morning', 'afternoon', 'evening', 'late-night'] as const

export type Scene = (typeof SCENES)[number]

// Boundaries (local hours): morning 05:00-11:59, afternoon 12:00-17:59,
// evening 18:00-22:59, late-night 23:00-04:59 (wraps past midnight).
export function sceneFor(now: Date): Scene {
  const hour = now.getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'late-night'
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

// The clock as the talk prompt renders it ("Monday 2026-08-31, 2:28 pm"). The
// weekday and date carry what the hour alone cannot — a Monday reads
// differently from a Saturday — and the minute separates hours the six-hour
// bucket lumps together. Hand-rolled rather than toLocaleString: ICU inserts a
// narrow no-break space before am/pm on some builds, and prompt text must be
// byte-stable across machines.
export function formatClock(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
  const hour = now.getHours() % 12 || 12
  return `${WEEKDAYS[now.getDay()]} ${date}, ${hour}:${two(now.getMinutes())} ${now.getHours() < 12 ? 'am' : 'pm'}`
}

// A non-empty but invalid override warns and degrades to the clock — a typo
// must never break the radio (same posture as the Config env knobs).
export function currentScene(now: Date, env: NodeJS.ProcessEnv = process.env): Scene {
  const override = env.MURMUR_SCENE?.trim()
  if (override) {
    if ((SCENES as readonly string[]).includes(override)) return override as Scene
    console.warn(
      `warning: ignoring invalid MURMUR_SCENE=${JSON.stringify(override)} ` +
        `(expected one of ${SCENES.join(', ')})`,
    )
  }
  return sceneFor(now)
}
