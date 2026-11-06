import type { Db } from '../lib/sqlite';
import { formatCents } from '../lib/money';
import { detectDuplicates, detectExpiringDiscounts, detectMatchExceptions, detectMessages } from './detectors';
import { rankAll } from './rank';
import type { DetectedIssue, Issue } from './types';

/** Copies in open duplicate issues, each mapped to the kept original. Copies must never be paid. */
export function duplicateCopies(issues: Issue[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of issues) {
    if (i.type !== 'duplicate_invoice') continue;
    for (const copy of i.details.copy_invoice_ids as string[]) out.set(copy, i.details.kept_invoice_id as string);
  }
  return out;
}

/**
 * One root cause, one issue: when a flagged email cites an invoice that also fails the match,
 * the email is what needs judging first, so the match finding travels inside the message issue.
 */
function foldMatchesIntoMessages(issues: DetectedIssue[]): DetectedIssue[] {
  const messages = issues.filter((i) => i.type === 'suspicious_message');
  const folded = new Set<DetectedIssue>();
  for (const msg of messages) {
    const matches = issues.filter((i) => i.type === 'match_exception' && msg.invoice_ids.includes(i.invoice_ids[0]!));
    if (!matches.length) continue;
    for (const m of matches) folded.add(m);
    const found = matches.map((m) => ({ invoice_id: m.invoice_ids[0]!, disputed_cents: m.details.disputed_cents as number }));
    msg.title += `; ${found.map((f) => `${f.invoice_id} is ${formatCents(f.disputed_cents)} over what PO and receipts support`).join('; ')}`;
    msg.details = { ...msg.details, match_exceptions: found };
    msg.evidence_ids = [...new Set([...msg.evidence_ids, ...matches.flatMap((m) => m.evidence_ids)])];
  }
  return issues.filter((i) => !folded.has(i));
}

/** All detectors over facts.db, ranked. Deterministic: same facts, same queue. */
export function detectIssues(db: Db): Issue[] {
  return rankAll(foldMatchesIntoMessages([...detectDuplicates(db), ...detectMatchExceptions(db), ...detectExpiringDiscounts(db), ...detectMessages(db)]));
}
