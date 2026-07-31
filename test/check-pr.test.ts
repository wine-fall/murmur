import { describe, expect, it } from 'vitest'

import { STATUS_LINE_CAP, validate, validateStatus } from '../.github/scripts/check-pr.ts'

const onDisk = (paths: string[]) => (path: string) => paths.includes(path)
const nothingOnDisk = () => false

describe('PR title conventions', () => {
  it('accepts a conventional title with a scope and a spec tag', () => {
    const errors = validate(
      'feat(voice): add Spark backend [spec 02]',
      'Implements specs/spec02/02-voice.md',
      onDisk(['specs/spec02/02-voice.md']),
    )
    expect(errors).toEqual([])
  })

  it('accepts a breaking-change marker', () => {
    expect(
      validate('feat(voice)!: drop the old backend [spec 02]', 'specs/DESIGN.md', onDisk(['specs/DESIGN.md'])),
    ).toEqual([])
  })

  it('rejects a title with no Conventional Commits type', () => {
    const errors = validate('add a thing', '', nothingOnDisk)
    expect(errors[0]).toContain('Conventional Commits type')
  })

  it('rejects a recognized type with no subject after the colon', () => {
    expect(validate('chore: ', '', nothingOnDisk)).toHaveLength(1)
  })
})

describe('spec requirement', () => {
  it('requires a spec tag on product-behavior PRs', () => {
    const errors = validate('fix: stop the crash', 'specs/DESIGN.md', onDisk(['specs/DESIGN.md']))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('spec tag')
  })

  it('accepts a sub-spec tag and is case-insensitive about it', () => {
    expect(
      validate('fix: stop the crash [SPEC 03-01]', 'see specs/DESIGN.md', onDisk(['specs/DESIGN.md'])),
    ).toEqual([])
  })

  it('requires the description to link a spec path', () => {
    const errors = validate('perf: faster startup [spec 01]', 'no links here', nothingOnDisk)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('must link a spec file')
  })

  it('rejects a linked spec path that does not exist in the repo', () => {
    const errors = validate('refactor: tidy [spec 01]', 'Implements specs/spec01/nope.md', nothingOnDisk)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('do not exist')
    expect(errors[0]).toContain('specs/spec01/nope.md')
  })

  it('passes when at least one of several linked paths exists', () => {
    expect(
      validate(
        'fix: tidy [spec 01]',
        'specs/gone.md and specs/DESIGN.md',
        onDisk(['specs/DESIGN.md']),
      ),
    ).toEqual([])
  })

  it('exempts infra and meta types from the spec requirement', () => {
    for (const type of ['ci', 'chore', 'docs', 'build', 'style', 'test', 'revert']) {
      expect(validate(`${type}: housekeeping`, '', nothingOnDisk)).toEqual([])
    }
  })
})

describe('STATUS.md as a card', () => {
  const card = [
    '# murmur — current focus',
    '',
    '## Where we are',
    '',
    '- spec 10 TUI — the wire (#71); the warmth kit (#74).',
    '',
    '## Open',
    '',
    '- **#76** (eng) Cut the first-music latency.',
    '- **#83** (watch) Enter during an IME composition may submit the line.',
    '',
    '## Pinned — do not relitigate',
    '',
    '- Specs 08 and 09 no longer exist.',
  ].join('\n')

  const allOpen = () => 'open' as const

  it('accepts a short card whose open issues are all still open', () => {
    expect(validateStatus(card, allOpen)).toEqual([])
  })

  it('rejects a card over the line cap', () => {
    const bloated = `${card}\n${'- filler\n'.repeat(STATUS_LINE_CAP)}`
    const errors = validateStatus(bloated, allOpen)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(String(STATUS_LINE_CAP))
  })

  it('rejects an Open entry pointing at a closed issue', () => {
    const errors = validateStatus(card, (n) => (n === 83 ? 'closed' : 'open'))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('#83')
  })

  it('ignores issue/PR numbers outside the Open section', () => {
    // The "Where we are" section is a list of MERGED PRs — always closed, and
    // never the gate's business.
    expect(validateStatus(card, (n) => (n === 71 || n === 74 ? 'closed' : 'open'))).toEqual([])
  })

  it('passes when the issue state could not be read (no token, offline)', () => {
    expect(validateStatus(card, () => 'unknown')).toEqual([])
  })

  it('rejects a card with no Open section, so renaming the heading cannot mute the gate', () => {
    const errors = validateStatus('# murmur\n\n## Pinned\n\n- a fact.', allOpen)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('## Open')
  })
})
