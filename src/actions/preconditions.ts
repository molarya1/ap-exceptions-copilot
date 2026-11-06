import type { DiscountResult } from '../calc/discount';
import type { MatchResult } from '../calc/match';
import { formatCents } from '../lib/money';
import type { Db } from '../lib/sqlite';
import type { Action } from './schema';

// Preconditions for one action against the facts. The same rules run twice:
// when the agent submits a plan (against its own tool results in that run), and again
// when a person approves (against freshly computed results on current data).

export interface CalcResults {
  match?: MatchResult;
  discount?: DiscountResult;
}

export interface ActionContext {
  db: Db;
  /** Calculator results to compare amounts against. */
  calc: (invoiceId: string) => CalcResults;
  /** Invoices that belong to an open duplicate issue. */
  duplicateInvoices: ReadonlySet<string>;
  /** Wording for a missing calculator result: plan checks ask the agent to call the tool. */
  missingCalc: (tool: 'match_check' | 'discount_value', invoiceId: string) => string;
}

interface InvoiceFacts {
  invoice_id: string;
  vendor_id: string;
  status: string;
  currency: string;
  open_cents: number;
  remit_account: string;
  contact_email: string;
  contact_name: string;
  contact_phone: string;
}

function invoiceFacts(db: Db, invoiceId: string): InvoiceFacts | undefined {
  return db.get<InvoiceFacts>(
    `SELECT i.invoice_id, i.vendor_id, i.status, i.currency, b.open_cents, v.remit_account, v.contact_email, v.contact_name, v.contact_phone
     FROM invoices i JOIN invoice_balances b USING (invoice_id) JOIN vendors v USING (vendor_id) WHERE i.invoice_id = ?`,
    [invoiceId],
  );
}

const PAYABLE_STATUSES = ['open', 'approved'];

export function actionProblems(a: Action, ctx: ActionContext): string[] {
  const { db } = ctx;
  if (a.type === 'verify_bank_change') return callbackProblems(a, db);

  const inv = invoiceFacts(db, a.invoice_id);
  if (!inv) return [`${a.type}: invoice ${a.invoice_id} does not exist.`];
  const p: string[] = [];
  const where = `${a.type} ${a.invoice_id}`;
  if (!PAYABLE_STATUSES.includes(inv.status)) p.push(`${where}: invoice status is ${inv.status}; only open or approved invoices can be acted on.`);

  if (a.type === 'schedule_payment' || a.type === 'short_pay') {
    if (ctx.duplicateInvoices.has(a.invoice_id)) p.push(`${where}: invoice is part of an open duplicate issue and cannot be paid until that is resolved.`);
    if (a.pay_to_account !== inv.remit_account) {
      p.push(`${where}: pay_to_account ${a.pay_to_account} is not the verified account on file. Payments go only to the account on file; a new account needs verify_bank_change first.`);
    }
    if (a.currency !== inv.currency) p.push(`${where}: currency ${a.currency} does not match the invoice currency ${inv.currency}.`);
    const { match, discount } = ctx.calc(a.invoice_id);
    if (!match) {
      p.push(ctx.missingCalc('match_check', a.invoice_id));
      return p;
    }
    const amount = a.type === 'schedule_payment' ? a.amount_cents : a.pay_cents;
    if (amount > inv.open_cents) p.push(`${where}: ${formatCents(amount)} is more than the open balance ${formatCents(inv.open_cents)}.`);

    if (a.type === 'schedule_payment') {
      if (!match.within_tolerance) p.push(`${where}: the match is outside tolerance; use short_pay for ${formatCents(match.payable_cents)} or hold_payment.`);
      if (a.take_discount) {
        if (!discount) p.push(ctx.missingCalc('discount_value', a.invoice_id));
        else if (!discount.eligible) p.push(`${where}: no discount available (${discount.reason}).`);
        else if (a.amount_cents !== discount.pay_with_discount_cents) p.push(`${where}: amount ${a.amount_cents} differs from discount_value.pay_with_discount_cents ${discount.pay_with_discount_cents}.`);
      } else if (a.amount_cents !== match.payable_cents) {
        p.push(`${where}: amount ${a.amount_cents} differs from match_check.payable_cents ${match.payable_cents}.`);
      }
    } else {
      if (match.within_tolerance) p.push(`${where}: the match is within tolerance, so there is nothing to short-pay.`);
      if (a.pay_cents !== match.payable_cents) p.push(`${where}: pay_cents ${a.pay_cents} differs from match_check.payable_cents ${match.payable_cents}.`);
      if (a.disputed_cents !== match.disputed_cents) p.push(`${where}: disputed_cents ${a.disputed_cents} differs from match_check.disputed_cents ${match.disputed_cents}.`);
    }
  }

  if (a.type === 'request_credit_note') {
    if (a.vendor_id !== inv.vendor_id) p.push(`${where}: invoice belongs to ${inv.vendor_id}, not ${a.vendor_id}.`);
    if (a.to.toLowerCase() !== inv.contact_email.toLowerCase()) p.push(`${where}: send only to the contact on file (${inv.contact_email}), not ${a.to}.`);
    const { match } = ctx.calc(a.invoice_id);
    if (!match) p.push(ctx.missingCalc('match_check', a.invoice_id));
    else if (match.disputed_cents <= 0) p.push(`${where}: match_check shows nothing disputed.`);
    else if (a.amount_cents !== match.disputed_cents) p.push(`${where}: amount ${a.amount_cents} differs from match_check.disputed_cents ${match.disputed_cents}.`);
  }
  return p;
}

function callbackProblems(a: Extract<Action, { type: 'verify_bank_change' }>, db: Db): string[] {
  const p: string[] = [];
  const vendor = db.get<{ contact_name: string; contact_phone: string; remit_account: string }>('SELECT contact_name, contact_phone, remit_account FROM vendors WHERE vendor_id = ?', [a.vendor_id]);
  if (!vendor) return [`verify_bank_change: vendor ${a.vendor_id} does not exist.`];
  if (!db.get('SELECT 1 FROM emails WHERE email_id = ?', [a.email_id])) p.push(`verify_bank_change: email ${a.email_id} does not exist.`);
  if (a.call_phone !== vendor.contact_phone) p.push(`verify_bank_change: call_phone must be the number on file (${vendor.contact_phone}), never one from an email.`);
  if (a.call_name !== vendor.contact_name) p.push(`verify_bank_change: call_name must be the contact on file (${vendor.contact_name}).`);
  if (a.claimed_account === vendor.remit_account) p.push('verify_bank_change: claimed_account is already the account on file; there is nothing to verify.');
  return p;
}
