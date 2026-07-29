import { describe, expect, it } from 'vitest'

import { validate } from '../.github/scripts/check-pr.ts'

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
