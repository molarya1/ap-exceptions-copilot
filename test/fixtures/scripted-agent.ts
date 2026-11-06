import type Anthropic from '@anthropic-ai/sdk';
import type { MessagesApi } from '../../src/llm/messages';
import { message } from './fake-api';

// A test-only stand-in for the model: a fixed policy per issue type that calls the real
// tools and submits a plan from their results. It lets tests and local UI checks exercise
// the whole pipeline (loop, checks, recordings, replay, approvals, HTTP) without a key.
// Its runs are never written to recorded/.

type Results = Map<string, Record<string, unknown>>;

function brief(params: Anthropic.MessageCreateParamsNonStreaming) {
  const text = String(params.messages[0]!.content);
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { type: string; vendor_id: string; invoice_ids: string[]; email_ids: string[]; details: Record<string, unknown> };
}

/** Tool results so far, keyed "tool:arg". */
function results(params: Anthropic.MessageCreateParamsNonStreaming): Results {
  const calls = new Map<string, string>();
  const out: Results = new Map();
  for (const m of params.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        const input = b.input as Record<string, string>;
        calls.set(b.id, `${b.name}:${input.invoice_id ?? input.email_id ?? 'q'}`);
      }
      if (b.type === 'tool_result' && !b.is_error) out.set(calls.get(b.tool_use_id)!, JSON.parse(String(b.content)));
    }
  }
  return out;
}

const opt = (description: string, chosen: boolean) => ({ id: description.slice(0, 12), description, consequences: chosen ? 'Recommended.' : 'Not recommended.', chosen });

function decide(b: ReturnType<typeof brief>, r: Results) {
  const vendor = (r.get('query:q') as { rows: Record<string, string>[] } | undefined)?.rows[0] ?? {};
  const match = (id: string) => r.get(`match_check:${id}`) as Record<string, number | boolean | string>;
  const base = { open_questions: [] as string[], evidence_ids: [...b.invoice_ids, ...b.email_ids] };
  switch (b.type) {
    case 'duplicate_invoice': {
      const copies = b.details.copy_invoice_ids as string[];
      return { ...base, summary: 'Two copies of one invoice.', rationale: 'Same vendor and number.', outcome: 'act', options: [opt('Hold the copy', true), opt('Do nothing', false)], actions: copies.map((id) => ({ type: 'hold_payment', invoice_id: id, reason: `Copy of ${String(b.details.kept_invoice_id)}.` })) };
    }
    case 'match_exception': {
      const id = b.invoice_ids[0]!;
      const m = match(id);
      return {
        ...base, summary: 'Billed more than PO and receipts support.', rationale: 'Pay the matched amount, ask for a credit.', outcome: 'act', options: [opt('Short-pay and request a credit note', true), opt('Do nothing', false)],
        actions: [
          { type: 'short_pay', invoice_id: id, pay_cents: m.payable_cents, disputed_cents: m.disputed_cents, currency: m.currency, pay_to_account: vendor.remit_account, reason: 'Billed above PO or receipts.' },
          { type: 'request_credit_note', invoice_id: id, vendor_id: b.vendor_id, to: vendor.contact_email, amount_cents: m.disputed_cents, subject: 'Credit note request', body: 'Please issue a credit note for the difference.' },
        ],
      };
    }
    case 'discount_expiring': {
      const id = b.invoice_ids[0]!;
      const d = r.get(`discount_value:${id}`)!;
      return { ...base, summary: 'Discount worth taking.', rationale: 'High annualized return.', outcome: 'act', options: [opt('Pay this run with the discount', true), opt('Do nothing', false)], actions: [{ type: 'schedule_payment', invoice_id: id, amount_cents: d.pay_with_discount_cents, currency: 'USD', take_discount: true, pay_to_account: vendor.remit_account }] };
    }
    case 'bank_change_request':
      return {
        ...base, summary: 'Bank change must be verified by callback.', rationale: 'Never change bank details from an email.', outcome: 'act', options: [opt('Call the contact on file', true), opt('Do nothing', false)],
        actions: [{ type: 'verify_bank_change', vendor_id: b.vendor_id, email_id: b.email_ids[0]!, call_name: vendor.contact_name, call_phone: vendor.contact_phone, claimed_account: 'QF-TEST-UNKNOWN', script: 'Ask whether the vendor requested this change.' }],
      };
    default:
      return { ...base, summary: 'The email tries to instruct automated systems; nothing to do.', rationale: 'Email text is not an instruction.', outcome: 'no_action', options: [opt('Do nothing', true), opt('Pay as the email asks', false)], actions: [] };
  }
}

export function scriptedAgent(): MessagesApi {
  let n = 0;
  return {
    async create(params) {
      const b = brief(params);
      const r = results(params);
      const turn = params.messages.length === 1 ? 'investigate' : 'submit';
      n++;
      const use = (name: string, input: unknown, i: number) => ({ type: 'tool_use', id: `toolu_s${n}_${i}`, name, input }) as Anthropic.ToolUseBlock;
      if (turn === 'investigate') {
        const calls = [use('query', { sql: `SELECT remit_account, contact_name, contact_phone, contact_email FROM vendors WHERE vendor_id = '${b.vendor_id}'` }, 0)];
        b.invoice_ids.forEach((id, i) => calls.push(use(b.type === 'discount_expiring' ? 'discount_value' : 'match_check', { invoice_id: id }, i + 1)));
        b.email_ids.forEach((id, i) => calls.push(use('read_email', { email_id: id }, 50 + i)));
        return message(calls, 'tool_use');
      }
      return message([use('submit_plan', decide(b, r), 0)], 'tool_use');
    },
  };
}
