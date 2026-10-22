// Program-level anti-repeat (spec 15 §2.6): a subject in a canonical form that
// an exact string match can trust. No judge call — the planner is told what is
// in cooldown, and code checks what came back.

import { Converter } from 'opencc-js/t2cn'

import type { ProgramId } from './catalogue.ts'

const toSimplified = Converter({ from: 't', to: 'cn' })

// NFKC folds full-width forms, case folds Latin, opencc folds traditional
// characters, and everything that is not a letter or a digit goes.
export function normalizeSubject(subject: string): string {
  return toSimplified(subject.normalize('NFKC').toLowerCase()).replace(/[^\p{L}\p{N}]/gu, '')
}

// What a plan is remembered by: the lead thinkers for `puzzle` (the question
// itself is never deduped), the subject for the others, nothing for `today`
// (the real-world ledger dedupes its items).
export function cooldownKeys(id: ProgramId, plan: { subject: string; leads?: readonly string[] | undefined }): string[] {
  if (id === 'today') return []
  const raw = id === 'puzzle' ? (plan.leads ?? []) : [plan.subject]
  return raw.map(normalizeSubject).filter((key) => key !== '')
}
