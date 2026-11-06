import { BUSINESS_DATE, DUPLICATE_WINDOW_DAYS, NEXT_RUN_DATE } from '../config';
import { discountValue } from '../calc/discount';
import { matchCheck } from '../calc/match';
import { invoiceNumberKey } from '../ingest/clean';
import { formatCents } from '../lib/money';
import type { Db } from '../lib/sqlite';
import type { DetectedIssue } from './types';

// Deterministic rules over facts.db. No model is involved in finding issues.
// Related symptoms are grouped into one issue per root cause.

const ACTIONABLE = "('open', 'approved')";

interface InvoiceRow {
  invoice_id: string;
  vendor_id: string;
  vendor_invoice_no: string;
  invoice_no_key: string;
  invoice_date: string;
  due_date: string;
  total_cents: number;
  total_usd_cents: number;
  status: string;
  legal_name: string;
}

const INVOICE_SELECT = `SELECT i.invoice_id, i.vendor_id, i.vendor_invoice_no, i.invoice_no_key, i.invoice_date, i.due_date,
  i.total_cents, i.total_usd_cents, i.status, v.legal_name FROM invoices i JOIN vendors v USING (vendor_id)`;

/** Same vendor and invoice-number key, or same vendor, amount and close dates. */
export function detectDuplicates(db: Db): DetectedIssue[] {
  const pairs = db.all<{ a: string; b: string; why: string }>(
    `SELECT a.invoice_id AS a, b.invoice_id AS b,
            CASE WHEN a.invoice_no_key = b.invoice_no_key THEN 'same invoice number' ELSE 'same amount within ${DUPLICATE_WINDOW_DAYS} days' END AS why
     FROM invoices a JOIN invoices b ON a.vendor_id = b.vendor_id AND a.invoice_id < b.invoice_id
     WHERE a.is_credit_note = 0 AND b.is_credit_note = 0
       AND (a.status IN ${ACTIONABLE} OR b.status IN ${ACTIONABLE})
       AND (a.invoice_no_key = b.invoice_no_key
            OR (a.total_cents = b.total_cents AND ABS(julianday(a.invoice_date) - julianday(b.invoice_date)) <= ${DUPLICATE_WINDOW_DAYS}))`,
  );
  // Union pairs into groups, so three copies of one invoice make one issue.
  const parent = new Map<string, string>();
  const root = (x: string): string => {
    const p = parent.get(x);
    return p === undefined || p === x ? x : root(p);
  };
  for (const p of pairs) parent.set(root(p.b), root(p.a));
  const groups = new Map<string, Set<string>>();
  for (const id of pairs.flatMap((p) => [p.a, p.b])) {
    const key = root(id);
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(id);
  }

  return [...groups.values()].map((ids) => {
    const rows = db.all<InvoiceRow>(`${INVOICE_SELECT} WHERE i.invoice_id IN (${[...ids].map(() => '?').join(',')}) ORDER BY i.invoice_id`, [...ids]);
    const first = rows[0]!;
    const reasons = [...new Set(pairs.filter((p) => ids.has(p.a)).map((p) => p.why))];
    const atRisk = rows.reduce((s, r) => s + r.total_usd_cents, 0) - Math.max(...rows.map((r) => r.total_usd_cents));
    const emails = relatedEmails(db, first.vendor_id, rows.map((r) => r.invoice_no_key));
    return {
      issue_id: `dup-${first.vendor_id}-${first.invoice_no_key}`,
      type: 'duplicate_invoice',
      title: `Possible duplicate: ${rows.map((r) => `${r.invoice_id} (${r.vendor_invoice_no}, ${r.status})`).join(' and ')} from ${first.legal_name}`,
      vendor_id: first.vendor_id,
      invoice_ids: rows.map((r) => r.invoice_id),
      email_ids: emails,
      money_at_risk_usd_cents: atRisk,
      deadline: rows.some((r) => r.status === 'approved') ? BUSINESS_DATE : rows.map((r) => r.due_date).sort()[0]!,
      evidence_ids: [...rows.map((r) => r.invoice_id), ...emails],
      details: { reasons, copies: rows.map((r) => ({ invoice_id: r.invoice_id, printed_number: r.vendor_invoice_no, status: r.status, total_cents: r.total_cents, invoice_date: r.invoice_date })) },
    };
  });
}

/** Three-way match failures beyond tolerance, one issue per invoice. */
export function detectMatchExceptions(db: Db): DetectedIssue[] {
  const rows = db.all<InvoiceRow>(`${INVOICE_SELECT} WHERE i.status IN ${ACTIONABLE} AND i.is_credit_note = 0 ORDER BY i.invoice_id`);
  const out: DetectedIssue[] = [];
  for (const r of rows) {
    const m = matchCheck(db, r.invoice_id);
    if (!m || m.exempt || m.within_tolerance) continue;
    const bad = m.lines.filter((l) => !l.within_tolerance);
    const rate = r.total_cents > 0 ? r.total_usd_cents / r.total_cents : 1;
    const emails = relatedEmails(db, r.vendor_id, [r.invoice_no_key]);
    out.push({
      issue_id: `match-${r.invoice_id}`,
      type: 'match_exception',
      title: `${r.invoice_id} (${r.vendor_invoice_no}) from ${r.legal_name} is ${formatCents(m.disputed_cents)} over what PO and receipts support`,
      vendor_id: r.vendor_id,
      invoice_ids: [r.invoice_id],
      email_ids: emails,
      money_at_risk_usd_cents: Math.round(m.disputed_cents * rate),
      deadline: r.due_date,
      evidence_ids: [r.invoice_id, ...bad.map((l) => l.po_line_id!).filter(Boolean), ...emails],
      details: { payable_cents: m.payable_cents, disputed_cents: m.disputed_cents, lines: bad.map((l) => ({ line_no: l.line_no, po_line_id: l.po_line_id, note: l.note, variance_cents: l.variance_cents })) },
    });
  }
  return out;
}

/** Early-payment discounts that close before the next run. */
export function detectExpiringDiscounts(db: Db): DetectedIssue[] {
  const rows = db.all<InvoiceRow>(`${INVOICE_SELECT} WHERE i.status IN ${ACTIONABLE} AND i.is_credit_note = 0 AND v.discount_days > 0 ORDER BY i.invoice_id`);
  const out: DetectedIssue[] = [];
  for (const r of rows) {
    const d = discountValue(db, r.invoice_id);
    if (!d?.must_pay_this_run_to_capture) continue;
    const emails = relatedEmails(db, r.vendor_id, [r.invoice_no_key]);
    out.push({
      issue_id: `disc-${r.invoice_id}`,
      type: 'discount_expiring',
      title: `${formatCents(d.discount_cents)} discount on ${r.invoice_id} (${r.vendor_invoice_no}) from ${r.legal_name} ends ${d.discount_deadline}, before the ${NEXT_RUN_DATE} run`,
      vendor_id: r.vendor_id,
      invoice_ids: [r.invoice_id],
      email_ids: emails,
      money_at_risk_usd_cents: d.discount_cents,
      deadline: d.discount_deadline!,
      evidence_ids: [r.invoice_id, ...emails],
      details: { terms: d.terms, discount_cents: d.discount_cents, pay_with_discount_cents: d.pay_with_discount_cents, annualized_return_pct: d.annualized_return_pct },
    });
  }
  return out;
}

interface FlaggedEmail {
  email_id: string;
  from_address: string;
  from_domain: string;
  subject: string;
  intent: string | null;
  new_bank_account: string | null;
}

/** Bank-detail change requests (with their trust flags) and any other flagged email. */
export function detectMessages(db: Db): DetectedIssue[] {
  const emails = db.all<FlaggedEmail>(
    `SELECT e.email_id, e.from_address, e.from_domain, e.subject, x.intent, x.new_bank_account
     FROM emails e LEFT JOIN email_extractions x USING (email_id) ORDER BY e.email_id`,
  );
  const out: DetectedIssue[] = [];
  for (const e of emails) {
    const flags = db.all<{ flag: string; detail: string }>('SELECT flag, detail FROM email_flags WHERE email_id = ? ORDER BY flag', [e.email_id]);
    const isBankChange = e.intent === 'bank_change' && e.new_bank_account !== null;
    if (!isBankChange && flags.length === 0) continue;

    const vendor = vendorForEmail(db, e.from_domain, flags);
    if (!vendor) continue;
    const claimed = db.all<{ value: string }>("SELECT value FROM email_claims WHERE email_id = ? AND kind = 'invoice_number'", [e.email_id]).map((c) => c.value);
    const open = db.all<InvoiceRow>(`${INVOICE_SELECT} WHERE i.vendor_id = ? AND i.status IN ${ACTIONABLE} AND i.is_credit_note = 0 ORDER BY i.due_date`, [vendor.vendor_id]);
    const mentioned = open.filter((i) => claimed.some((c) => invoiceNumberKey(c) === i.invoice_no_key));
    const exposed = isBankChange ? open : mentioned;
    const priorNotes = isBankChange ? earlierBankNotes(db, e) : [];

    out.push({
      issue_id: `${isBankChange ? 'bank' : 'msg'}-${e.email_id}`,
      type: isBankChange ? 'bank_change_request' : 'suspicious_message',
      title: isBankChange
        ? `Request to change ${vendor.legal_name}'s remit-to account (email ${e.email_id}${flags.length ? `, flagged: ${flags.map((f) => f.flag).join(', ')}` : ''})`
        : `Email ${e.email_id} "${e.subject}" is flagged: ${flags.map((f) => f.flag).join(', ')}`,
      vendor_id: vendor.vendor_id,
      invoice_ids: exposed.map((i) => i.invoice_id),
      email_ids: [e.email_id, ...priorNotes],
      money_at_risk_usd_cents: exposed.reduce((s, i) => s + i.total_usd_cents, 0),
      deadline: exposed[0]?.due_date ?? NEXT_RUN_DATE,
      evidence_ids: [e.email_id, ...priorNotes, ...exposed.map((i) => i.invoice_id)],
      details: { flags, sender: e.from_address, claimed_account: e.new_bank_account, account_on_file: vendor.remit_account },
    });
  }
  return out;
}

function vendorForEmail(db: Db, domain: string, flags: { flag: string; detail: string }[]) {
  type V = { vendor_id: string; legal_name: string; remit_account: string };
  const direct = db.get<V>('SELECT vendor_id, legal_name, remit_account FROM vendors WHERE email_domain = ?', [domain]);
  if (direct) return direct;
  // A look-alike sender is attributed to the vendor it imitates.
  const twin = flags.find((f) => f.flag === 'lookalike_domain')?.detail.match(/\b(V\d{3})\b/)?.[1];
  return twin ? db.get<V>('SELECT vendor_id, legal_name, remit_account FROM vendors WHERE vendor_id = ?', [twin]) : undefined;
}

/** Earlier emails from the same sender domain that mention banking. */
function earlierBankNotes(db: Db, e: FlaggedEmail): string[] {
  return db
    .all<{ email_id: string }>(
      `SELECT DISTINCT e.email_id FROM emails e JOIN email_claims c USING (email_id)
       WHERE e.from_domain = ? AND e.email_id < ? AND c.kind IN ('bank_name', 'bank_account') ORDER BY e.email_id`,
      [e.from_domain, e.email_id],
    )
    .map((r) => r.email_id);
}

/** Emails from the vendor's own domain that cite one of these invoice numbers. */
function relatedEmails(db: Db, vendorId: string, keys: string[]): string[] {
  const rows = db.all<{ email_id: string; value: string }>(
    `SELECT DISTINCT c.email_id, c.value FROM email_claims c JOIN emails e USING (email_id) JOIN vendors v ON v.email_domain = e.from_domain
     WHERE v.vendor_id = ? AND c.kind = 'invoice_number' ORDER BY c.email_id`,
    [vendorId],
  );
  return [...new Set(rows.filter((r) => keys.includes(invoiceNumberKey(r.value))).map((r) => r.email_id))];
}
