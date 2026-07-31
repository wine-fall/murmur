// Validate a pull request's title and description, and keep specs/STATUS.md a
// card rather than a ledger.
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
//   4. STATUS.md stays under STATUS_LINE_CAP lines.
//   5. Every issue the STATUS "## Open" section points at is still open.
//
// Rules 2-3 apply only to product-behavior PRs (feat/fix/perf/refactor);
// infra/meta types (ci/chore/docs/build/style/test/revert) are exempt from the
// spec requirement — they still must satisfy rule 1. Rules 4-5 apply to every
// PR: STATUS.md is read at the start of every session, so its two failure
// modes (unbounded growth, stale pointers) are worth a mechanical gate.
//
// Exits 0 on pass, 1 on any violation, with GitHub Actions ::error::
// annotations.

import { readFileSync, statSync } from 'node:fs'

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

export const STATUS_PATH = 'specs/STATUS.md'

// STATUS.md is a card, not a ledger (see its own header and the murmur-backlog
// skill). The cap is the only thing that makes that rule mechanical: the file
// stood at 66 lines after the 2026-07-31 backlog migration, and 85 is that plus
// ~25% headroom — enough for a few new pointer lines or a reworded section,
// not enough to absorb a build write-up. Raising it is a decision, not a fix:
// if a change needs more room, the detail belongs in the spec it verifies or in
// its own issue, and the cap moves only when the card's shape genuinely grows.
export const STATUS_LINE_CAP = 85

// 'unknown' = the state could not be read (no token, offline, API failure).
// It never fails the build: this gate catches stale pointers, and a gate that
// turns red because the network hiccuped teaches people to ignore it.
export type IssueState = 'open' | 'closed' | 'unknown'

// The "## Open" section only — the "Where we are" list is merged PR numbers,
// which are closed by definition and none of this gate's business.
function openSection(text: string): string | null {
  const match = /^##\s+Open\s*$/m.exec(text)
  if (match === null) return null
  const rest = text.slice(match.index + match[0].length)
  const next = /^##\s+/m.exec(rest)
  return next === null ? rest : rest.slice(0, next.index)
}

export function validateStatus(text: string, issueState: (issue: number) => IssueState): string[] {
  const errors: string[] = []

  const lines = text.trimEnd().split('\n').length
  if (lines > STATUS_LINE_CAP) {
    errors.push(
      `${STATUS_PATH} is ${lines} lines, over the ${STATUS_LINE_CAP}-line cap.\n` +
        'It is a card, not a ledger: delete completed entries, move measured facts into the\n' +
        'spec they verify, and let issue bodies carry the detail (see the murmur-backlog skill).',
    )
  }

  const open = openSection(text)
  if (open === null) {
    errors.push(
      `${STATUS_PATH} has no "## Open" section — the backlog index is the one section this gate reads.`,
    )
    return errors
  }

  const stale = [...new Set([...open.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))]
    .filter((issue) => issueState(issue) === 'closed')
    .sort((a, b) => a - b)
  if (stale.length > 0) {
    errors.push(
      `${STATUS_PATH} "## Open" points at closed issue(s): ${stale.map((n) => `#${n}`).join(', ')}.\n` +
        'Closing a debt deletes its line here in the same change (murmur-backlog: close).',
    )
  }

  return errors
}

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

function stateOf(payload: unknown): IssueState {
  if (typeof payload !== 'object' || payload === null || !('state' in payload)) return 'unknown'
  const { state } = payload
  return state === 'open' || state === 'closed' ? state : 'unknown'
}

// One REST read per referenced issue (there are a handful, so no batching).
// Every failure path lands on 'unknown', which passes — see IssueState.
async function fetchIssueStates(text: string): Promise<(issue: number) => IssueState> {
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  const token = process.env.GITHUB_TOKEN ?? ''
  const section = openSection(text)
  if (repo === '' || token === '' || section === null) {
    if (section !== null) console.log('(issue-state check skipped: no GITHUB_REPOSITORY / GITHUB_TOKEN)')
    return () => 'unknown'
  }

  const states = new Map<number, IssueState>()
  for (const issue of new Set([...section.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issue}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      })
      states.set(issue, response.ok ? stateOf(await response.json()) : 'unknown')
    } catch {
      states.set(issue, 'unknown') // network/DNS: never fail the build on it
    }
  }
  return (issue) => states.get(issue) ?? 'unknown'
}

function report(heading: string, errors: string[]): void {
  console.log(`::error::${heading}`)
  for (const error of errors) {
    const [head, ...rest] = error.split('\n')
    console.log(`  - ${head}`)
    for (const line of rest) console.log(`    ${line}`)
  }
  console.log()
}

async function main(): Promise<number> {
  const title = (process.env.PR_TITLE ?? '').trim()
  const body = process.env.PR_BODY ?? ''
  const prErrors = validate(title, body)

  // Read on every run; an unreadable STATUS.md is itself a failure worth seeing.
  let status = ''
  try {
    status = readFileSync(STATUS_PATH, 'utf-8')
  } catch (err) {
    console.log(`::error::Could not read ${STATUS_PATH}: ${String(err)}`)
    return 1
  }
  const statusErrors = validateStatus(status, await fetchIssueStates(status))

  if (prErrors.length > 0) {
    report(`Invalid PR title/description: ${JSON.stringify(title)}`, prErrors)
    console.log('Example title:        feat(brain): add music search [spec 03-01]')
    console.log('Example description:  Implements specs/spec03/03-01-brain-harness.md')
    console.log()
  }
  if (statusErrors.length > 0) report(`${STATUS_PATH} is out of contract`, statusErrors)
  if (prErrors.length > 0 || statusErrors.length > 0) return 1

  console.log(`OK: ${title}`)
  const prType = TYPE_RE.exec(title)?.[1] ?? ''
  if (!REQUIRE_SPEC.has(prType)) console.log(`(${prType}: spec reference not required)`)
  console.log(`OK: ${STATUS_PATH} (${status.trimEnd().split('\n').length}/${STATUS_LINE_CAP} lines)`)
  return 0
}

if (import.meta.main) process.exit(await main())
