import type { Db } from '../lib/sqlite';
import { detectDuplicates, detectExpiringDiscounts, detectMatchExceptions, detectMessages } from './detectors';
import { rankAll } from './rank';
import type { Issue } from './types';

/** Copies in open duplicate issues, each mapped to the kept original. Copies must never be paid. */
export function duplicateCopies(issues: Issue[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of issues) {
    if (i.type !== 'duplicate_invoice') continue;
    for (const copy of i.details.copy_invoice_ids as string[]) out.set(copy, i.details.kept_invoice_id as string);
  }
  return out;
}

/** All detectors over facts.db, ranked. Deterministic: same facts, same queue. */
export function detectIssues(db: Db): Issue[] {
  return rankAll([...detectDuplicates(db), ...detectMatchExceptions(db), ...detectExpiringDiscounts(db), ...detectMessages(db)]);
}
