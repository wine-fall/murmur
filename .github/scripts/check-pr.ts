// Validate a pull request's title and description against murmur conventions.
//
// Reads PR_TITLE and PR_BODY from the environment (set by the workflow) and
// runs from the repo root so referenced spec files can be checked on disk.
//
// Rules
//   1. Conventional Commits: the title starts with a recognized type, an
//      optional (scope), an optional breaking "!", then ": " and a subject.
//   2. Spec tag: the title contains [spec NN] (or [spec NN-NN] for a
//      sub-spec), e.g. [spec 01] / [spec 03-01].
//   3. Spec link: the description references at least one Markdown file under
//      specs/ that actually exists in the repo — at any directory depth
//      (e.g. specs/DESIGN.md or specs/spec03/03-01-brain-harness.md).
//
// Rules 2-3 apply only to product-behavior PRs (feat/fix/perf/refactor);
// infra/meta types (ci/chore/docs/build/style/test/revert) are exempt from the
// spec requirement — they still must satisfy rule 1.
//
// Exits 0 on pass, 1 on any violation, with GitHub Actions ::error::
// annotations.

import { statSync } from 'node:fs'

// Conventional Commits types (the widely-used Angular set).
const TYPES = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
] as const

// Types whose PRs must reference a spec (product behavior). The rest are meta.
const REQUIRE_SPEC = new Set<string>(['feat', 'fix', 'perf', 'refactor'])

const TITLE_RE = new RegExp(`^(?:${TYPES.join('|')})(?:\\([^)]+\\))?!?: .+`)
const TYPE_RE = /^([a-z]+)/
// [spec 01] / [spec 03-01] / [spec1]  (space optional, sub-spec optional)
const SPEC_TAG_RE = /\[spec ?\d{1,2}(?:-\d{1,2})?\]/i
// Any Markdown path under specs/, at any depth:
//   specs/DESIGN.md , specs/spec03/03-01-brain-harness.md
const SPEC_PATH_RE = /specs\/[\w./-]+\.md/g

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function validate(title: string, body: string, exists: (path: string) => boolean = isFile): string[] {
  const errors: string[] = []

  if (!TITLE_RE.test(title)) {
    errors.push(
      `Title must start with a Conventional Commits type (${TYPES.join(', ')}) then ': '.\n` +
        'e.g.  feat(voice): add Spark backend [spec 02]',
    )
  }

  const prType = TYPE_RE.exec(title)?.[1] ?? ''
  if (!REQUIRE_SPEC.has(prType)) return errors

  // Spec tag + linked spec path are required only for product-behavior PRs.
  if (!SPEC_TAG_RE.test(title)) {
    errors.push('Title must carry a spec tag: [spec 01], or [spec 03-01] for a sub-spec.')
  }

  // The description must link a Markdown file under specs/ that exists on disk
  // (any depth — specs/DESIGN.md, specs/spec03/03-01-brain-harness.md, …).
  const linked = body.match(SPEC_PATH_RE) ?? []
  if (linked.length === 0) {
    errors.push(
      'Description must link a spec file under specs/ by path, e.g. specs/spec03/03-01-brain-harness.md.',
    )
  } else if (!linked.some(exists)) {
    const unique = [...new Set(linked)].sort()
    errors.push(`The specs/ path(s) in the description do not exist in the repo: ${unique.join(', ')}.`)
  }

  return errors
}

function main(): number {
  const title = (process.env.PR_TITLE ?? '').trim()
  const body = process.env.PR_BODY ?? ''
  const errors = validate(title, body)

  if (errors.length > 0) {
    console.log(`::error::Invalid PR title/description: ${JSON.stringify(title)}`)
    for (const error of errors) {
      const [head, ...rest] = error.split('\n')
      console.log(`  - ${head}`)
      for (const line of rest) console.log(`    ${line}`)
    }
    console.log()
    console.log('Example title:        feat(brain): add music search [spec 03-01]')
    console.log('Example description:  Implements specs/spec03/03-01-brain-harness.md')
    return 1
  }

  console.log(`OK: ${title}`)
  const prType = TYPE_RE.exec(title)?.[1] ?? ''
  if (!REQUIRE_SPEC.has(prType)) console.log(`(${prType}: spec reference not required)`)
  return 0
}

if (import.meta.main) process.exit(main())
