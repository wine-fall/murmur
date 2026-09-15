// The scan sign-in, as one loop (spec 14 §2.8). NetEase and Bilibili both
// hand out a code, wait for the phone app to confirm it, and answer with the
// cookie — the shape Soda Music has mounted through since §6. Nothing here
// knows which platform it is serving: the caller brings the two calls and
// says what a confirmation carries.
//
// A scan is a person picking up a phone, so the patience is generous and the
// cadence is slow; Esc is checked on both sides of the wait, because three
// minutes is a long time to be stuck with a code one no longer wants.

// The QR poll cadence and patience (spec 14 §3.1).
export const QR_POLL_MS = 2_000
export const QR_TIMEOUT_MS = 3 * 60_000

// What one poll saw. 'scanned' means the phone has the code and the person
// has not confirmed yet — it reads as waiting, and exists so a platform's
// own vocabulary survives the translation.
export type QrStatus = 'waiting' | 'scanned' | 'confirmed' | 'expired'
export type QrPoll<T> = { status: QrStatus; value?: T | undefined }

export type ScanDeps<T> = {
  // Where the code's URL goes — the flow draws it; it never reaches the log.
  show: (url: string) => void
  issue: () => Promise<{ url: string }>
  poll: () => Promise<QrPoll<T>>
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  cancelled?: () => boolean
}

export type ScanResult<T> = { ok: true; value: T } | { ok: false; reason: 'timeout' | 'cancelled' }

export async function scanToSignIn<T>(deps: ScanDeps<T>): Promise<ScanResult<T>> {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const code = await deps.issue()
  deps.show(code.url)
  const deadline = now().getTime() + (deps.timeoutMs ?? QR_TIMEOUT_MS)
  while (now().getTime() < deadline) {
    if (deps.cancelled?.() === true) return { ok: false, reason: 'cancelled' }
    const seen = await deps.poll()
    // A confirmation the platform sent without the cookie is not a sign-in:
    // waiting it out ends as a timeout, which is a code the listener can
    // ask for again — better than mounting an account with no credential.
    if (seen.status === 'confirmed' && seen.value !== undefined) return { ok: true, value: seen.value }
    if (seen.status === 'expired') return { ok: false, reason: 'timeout' }
    await sleep(QR_POLL_MS)
    if (deps.cancelled?.() === true) return { ok: false, reason: 'cancelled' }
  }
  return { ok: false, reason: 'timeout' }
}

// What a mount through a scan answers with: a signed-in account, or the one
// of three ways it did not get there.
export type QrMountResult<T> = { ok: true; who: string; entry: T } | { ok: false; reason: 'login-required' | 'timeout' | 'cancelled' }

export type QrMountOptions = {
  show: (url: string) => void
  timeoutMs?: number
  cancelled?: () => boolean
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}
