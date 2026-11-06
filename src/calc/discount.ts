import { BUSINESS_DATE, NEXT_RUN_DATE } from '../config';
import { addDays, daysBetween } from '../lib/dates';
import type { Db } from '../lib/sqlite';
import { matchCheck } from './match';

// Value of paying early under terms like 2/10 NET30. The discount applies to the amount
// the three-way match supports paying, never to an overbilled total.

export interface DiscountResult {
  invoice_id: string;
  terms: string;
  eligible: boolean;
  reason: string;
  discount_deadline: string | null;
  net_due_date: string;
  base_cents: number;
  discount_cents: number;
  pay_with_discount_cents: number;
  annualized_return_pct: number;
  must_pay_this_run_to_capture: boolean;
  match_within_tolerance: boolean;
}

export function discountValue(db: Db, invoiceId: string): DiscountResult | null {
  const inv = db.get<{ invoice_date: string; due_date: string; status: string; is_credit_note: number; payment_terms: string; discount_pct: number; discount_days: number; net_days: number }>(
    `SELECT i.invoice_date, i.due_date, i.status, i.is_credit_note, v.payment_terms, v.discount_pct, v.discount_days, v.net_days
     FROM invoices i JOIN vendors v USING (vendor_id) WHERE i.invoice_id = ?`,
    [invoiceId],
  );
  const match = matchCheck(db, invoiceId);
  if (!inv || !match) return null;

  const deadline = inv.discount_days > 0 ? addDays(inv.invoice_date, inv.discount_days) : null;
  const base = match.payable_cents;
  const discount = Math.round(base * inv.discount_pct);
  const spanDays = inv.net_days - inv.discount_days;
  const annualized = inv.discount_pct > 0 && spanDays > 0 ? (inv.discount_pct / (1 - inv.discount_pct)) * (365 / spanDays) : 0;

  let reason = 'eligible';
  if (!deadline) reason = 'vendor terms have no early-payment discount';
  else if (inv.is_credit_note) reason = 'credit notes earn no discount';
  else if (!['open', 'approved'].includes(inv.status)) reason = `invoice status is ${inv.status}`;
  else if (deadline < BUSINESS_DATE) reason = `discount window closed on ${deadline}`;
  const eligible = reason === 'eligible';

  return {
    invoice_id: invoiceId,
    terms: inv.payment_terms,
    eligible,
    reason,
    discount_deadline: deadline,
    net_due_date: inv.due_date,
    base_cents: base,
    discount_cents: eligible ? discount : 0,
    pay_with_discount_cents: eligible ? base - discount : base,
    annualized_return_pct: Math.round(annualized * 1000) / 10,
    must_pay_this_run_to_capture: eligible && deadline !== null && deadline < NEXT_RUN_DATE,
    match_within_tolerance: match.within_tolerance,
  };
}

export const daysUntil = (iso: string) => daysBetween(BUSINESS_DATE, iso);
