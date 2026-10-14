import { describe, expect, it } from 'vitest'

import { supportsNode } from '../src/node-floor.ts'

// The door check mirrors package.json engines (`^22.16.0 || >=24`): the floor
// is node:sqlite with FTS5, which 22.16 and 24.0 ship and 22.15 and 23.x lack.
describe('supportsNode', () => {
  it('admits 22.16+ on the 22 line and every 24+', () => {
    for (const v of ['v22.16.0', 'v22.23.2', 'v24.0.0', 'v24.14.0', 'v26.3.0']) {
      expect(supportsNode(v), v).toBe(true)
    }
  })

  it('turns away the releases without FTS5', () => {
    for (const v of ['v20.19.6', 'v22.13.0', 'v22.15.1', 'v23.10.0']) {
      expect(supportsNode(v), v).toBe(false)
    }
  })
})
