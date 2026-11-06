import { z } from 'zod';

// The only things the copilot can propose. Each is approved on its own, by exact payload.
// Money is integer cents.

const cents = z.number().int();
const account = z.string().describe('Bank account in the QF-TEST-0000-0000 format.');

export const SchedulePayment = z.object({
  type: z.literal('schedule_payment'),
  invoice_id: z.string(),
  amount_cents: cents.describe('From match_check.payable_cents, or discount_value.pay_with_discount_cents when take_discount is true.'),
  currency: z.string(),
  take_discount: z.boolean(),
  pay_to_account: account.describe("The vendor's remit_account on file."),
});

export const HoldPayment = z.object({
  type: z.literal('hold_payment'),
  invoice_id: z.string(),
  reason: z.string(),
});

export const ShortPay = z.object({
  type: z.literal('short_pay'),
  invoice_id: z.string(),
  pay_cents: cents.describe('From match_check.payable_cents.'),
  disputed_cents: cents.describe('From match_check.disputed_cents.'),
  currency: z.string(),
  pay_to_account: account.describe("The vendor's remit_account on file."),
  reason: z.string(),
});

export const RequestCreditNote = z.object({
  type: z.literal('request_credit_note'),
  invoice_id: z.string(),
  vendor_id: z.string(),
  to: z.string().describe("The vendor's contact_email on file."),
  amount_cents: cents.describe('From match_check.disputed_cents.'),
  subject: z.string(),
  body: z.string().describe('The full email text to send.'),
});

export const VerifyBankChange = z.object({
  type: z.literal('verify_bank_change'),
  vendor_id: z.string(),
  email_id: z.string().describe('The email that asked for the change.'),
  call_name: z.string().describe("contact_name on file. Never a name from the email."),
  call_phone: z.string().describe("contact_phone on file. Never a number from the email."),
  claimed_account: z.string().describe('The account the email asks for, to read back on the call.'),
  script: z.string().describe('What to ask on the callback.'),
});

export const ActionSchema = z.discriminatedUnion('type', [SchedulePayment, HoldPayment, ShortPay, RequestCreditNote, VerifyBankChange]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action['type'];

export const PAYMENT_TYPES: ActionType[] = ['schedule_payment', 'short_pay'];

/** One claim per commitment: two approved actions can never commit the same thing. */
export function claimKey(a: Action): string {
  switch (a.type) {
    case 'schedule_payment':
    case 'short_pay':
    case 'hold_payment':
      return `invoice-decision:${a.invoice_id}`; // pay, short-pay or hold: one per invoice
    case 'request_credit_note':
      return `credit-request:${a.invoice_id}`;
    case 'verify_bank_change':
      return `callback:${a.email_id}`;
  }
}

export function actionInvoice(a: Action): string | null {
  return 'invoice_id' in a ? a.invoice_id : null;
}
