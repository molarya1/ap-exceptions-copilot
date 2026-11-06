import { BUSINESS_DATE, COMPANY } from '../config';
import { formatCents } from '../lib/money';
import type { Db } from '../lib/sqlite';
import type { Action } from './schema';

// The exact document each action produces when sent. The UI shows this before approval,
// and the outbox stores it after. Sending is simulated: the outbox row is the end of the line.

export interface ActionDocument {
  kind: 'payment_run_entry' | 'payment_hold' | 'email' | 'callback_task';
  title: string;
  fields: [string, string][];
  body?: string;
}

export function renderDocument(a: Action, db: Db): ActionDocument {
  const vendor = (id: string) => db.get<{ legal_name: string }>('SELECT legal_name FROM vendors WHERE vendor_id = ?', [id])?.legal_name ?? id;
  const invoice = (id: string) => db.get<{ vendor_id: string; vendor_invoice_no: string; currency: string }>('SELECT vendor_id, vendor_invoice_no, currency FROM invoices WHERE invoice_id = ?', [id]);
  switch (a.type) {
    case 'schedule_payment': {
      const inv = invoice(a.invoice_id);
      return {
        kind: 'payment_run_entry',
        title: `Pay ${a.invoice_id} in the ${BUSINESS_DATE} run`,
        fields: [
          ['Vendor', inv ? vendor(inv.vendor_id) : '?'],
          ['Invoice', `${a.invoice_id} (vendor no. ${inv?.vendor_invoice_no ?? '?'})`],
          ['Amount', formatCents(a.amount_cents, a.currency)],
          ['Early-payment discount', a.take_discount ? 'taken' : 'no'],
          ['Pay to account', a.pay_to_account],
        ],
      };
    }
    case 'short_pay': {
      const inv = invoice(a.invoice_id);
      return {
        kind: 'payment_run_entry',
        title: `Short-pay ${a.invoice_id} in the ${BUSINESS_DATE} run`,
        fields: [
          ['Vendor', inv ? vendor(inv.vendor_id) : '?'],
          ['Invoice', `${a.invoice_id} (vendor no. ${inv?.vendor_invoice_no ?? '?'})`],
          ['Pay now', formatCents(a.pay_cents, a.currency)],
          ['Disputed, recorded as open', formatCents(a.disputed_cents, a.currency)],
          ['Pay to account', a.pay_to_account],
          ['Reason', a.reason],
        ],
      };
    }
    case 'hold_payment':
      return { kind: 'payment_hold', title: `Hold ${a.invoice_id} out of the payment run`, fields: [['Invoice', a.invoice_id], ['Reason', a.reason]] };
    case 'request_credit_note':
      return {
        kind: 'email',
        title: `Email ${vendor(a.vendor_id)}: request a credit note`,
        fields: [['From', COMPANY.apInbox], ['To', a.to], ['Subject', a.subject], ['Credit requested', formatCents(a.amount_cents)]],
        body: a.body,
      };
    case 'verify_bank_change':
      return {
        kind: 'callback_task',
        title: `Call ${vendor(a.vendor_id)} to verify a bank-detail change`,
        fields: [
          ['Call', a.call_name],
          ['Phone (on file)', a.call_phone],
          ['Account the email asks for', a.claimed_account],
          ['Requested in', a.email_id],
          ['Bank details on file', 'unchanged by this task'],
        ],
        body: a.script,
      };
  }
}
