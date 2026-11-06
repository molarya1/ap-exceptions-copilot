import { actionProblems, type CalcResults } from '../actions/preconditions';
import { claimKey, PAYMENT_TYPES } from '../actions/schema';
import type { Issue } from '../detect/types';
import type { Db } from '../lib/sqlite';
import type { Plan } from './plan';

// Checks: code rules every plan must pass before it is stored. Problems go back to the
// model as specific, fixable messages.

export interface CheckContext {
  db: Db;
  issue: Issue;
  /** match_check and discount_value results from tool calls in this run. */
  runCalc: Map<string, CalcResults>;
  duplicateCopies: ReadonlyMap<string, string>;
}

const ID_LOOKUPS: [RegExp, string][] = [
  [/^AP-\d{2}-\d{4}$/, 'SELECT 1 FROM invoices WHERE invoice_id = ?'],
  [/^m\d{2}$/, 'SELECT 1 FROM emails WHERE email_id = ?'],
  [/^PO-\d+-\d+$/, 'SELECT 1 FROM po_lines WHERE po_line_id = ?'],
  [/^PO-\d+$/, 'SELECT 1 FROM purchase_orders WHERE po_id = ?'],
  [/^R-\d+$/, 'SELECT 1 FROM receipts WHERE receipt_id = ?'],
  [/^V\d{3}$/, 'SELECT 1 FROM vendors WHERE vendor_id = ?'],
  [/^PAY-\d+$/, 'SELECT 1 FROM payments WHERE payment_id = ?'],
];

export function idExists(db: Db, id: string): boolean {
  const lookup = ID_LOOKUPS.find(([re]) => re.test(id));
  return lookup ? db.get(lookup[1], [id]) !== undefined : false;
}

export function checkPlan(plan: Plan, ctx: CheckContext): string[] {
  const p: string[] = [];

  const chosen = plan.options.filter((o) => o.chosen);
  if (plan.options.length < 2) p.push('Compare at least two real options, including doing nothing.');
  if (chosen.length !== 1) p.push(`Choose exactly one option; ${chosen.length} are marked chosen.`);

  if (plan.evidence_ids.length === 0) p.push('Cite at least one evidence id.');
  for (const id of plan.evidence_ids) if (!idExists(ctx.db, id)) p.push(`Evidence id ${id} does not exist.`);

  if (plan.outcome === 'act' && plan.actions.length === 0) p.push('Outcome "act" needs at least one action.');
  if (plan.outcome === 'no_action' && plan.actions.length > 0) p.push('Outcome "no_action" must have no actions.');
  if (plan.outcome === 'hold_and_ask') {
    if (plan.open_questions.length === 0) p.push('Outcome "hold_and_ask" needs at least one open question.');
    if (plan.actions.some((a) => PAYMENT_TYPES.includes(a.type))) p.push('Outcome "hold_and_ask" cannot include payments.');
  }

  if (ctx.issue.type === 'bank_change_request') {
    for (const a of plan.actions) {
      if (a.type !== 'verify_bank_change' && a.type !== 'hold_payment') {
        p.push(`${a.type}: the only allowed response to a bank-change request is verify_bank_change (optionally with hold_payment).`);
      }
    }
  }

  const keys = new Set<string>();
  for (const a of plan.actions) {
    const key = claimKey(a);
    if (keys.has(key)) p.push(`Two actions commit the same thing (${key}); keep one.`);
    keys.add(key);
    p.push(
      ...actionProblems(a, {
        db: ctx.db,
        calc: (id) => ctx.runCalc.get(id) ?? {},
        duplicateCopies: ctx.duplicateCopies,
        missingCalc: (tool, id) => `Call ${tool} for ${id} in this run; amounts must come from its result.`,
      }),
    );
  }
  return p;
}
