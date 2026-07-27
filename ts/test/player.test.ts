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
})
