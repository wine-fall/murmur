import { describe, expect, it } from 'vitest'

import { SubprocessPlayer } from '../src/player.ts'

describe('SubprocessPlayer', () => {
  it('resolves when the player process exits', async () => {
    // Stand-in binary: `true` ignores its argument and exits immediately.
    const player = new SubprocessPlayer('true')
    await expect(player.play({ source: '/dev/null', kind: 'talk' })).resolves.toBeUndefined()
  })

  it('stop() terminates a playing process and settles play()', async () => {
    // Stand-in: `sleep` with the clip source as its duration argument.
    const player = new SubprocessPlayer('sleep')
    const playing = player.play({ source: '30', kind: 'talk' })
    await new Promise((r) => setTimeout(r, 50))
    const t0 = Date.now()
    await player.stop()
    await playing
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('a missing binary degrades to a silent no-op instead of crashing', async () => {
    const player = new SubprocessPlayer('/no/such/binary')
    await expect(player.play({ source: 'x', kind: 'talk' })).resolves.toBeUndefined()
    await expect(player.stop()).resolves.toBeUndefined()
  })

  it('stop() during the failed-spawn window must not signal this process', async () => {
    // Regression (codex review): kill() on a pid-less child signals the
    // caller's own process group. stop() is called in the same tick as play,
    // before the async spawn 'error' event has cleared the child.
    let selfSignalled = false
    const onTerm = () => (selfSignalled = true)
    process.once('SIGTERM', onTerm)
    try {
      const player = new SubprocessPlayer('/no/such/binary')
      const playing = player.play({ source: 'x', kind: 'talk' })
      await player.stop() // same tick: child set, pid undefined
      await playing
      await new Promise((r) => setTimeout(r, 20))
      expect(selfSignalled).toBe(false)
    } finally {
      process.off('SIGTERM', onTerm)
    }
  })
})
