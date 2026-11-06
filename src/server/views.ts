import { renderDocument } from '../actions/documents';
import { ActionSchema } from '../actions/schema';
import type { App } from '../app';
import type { ToolCallRecord } from '../agent/loop';
import { BUSINESS_DATE, NEXT_RUN_DATE } from '../config';
import { formatCents } from '../lib/money';
import type { Db } from '../lib/sqlite';
import type { ActionRow } from '../work/store';

// JSON shapes for the UI. Everything here is read-only.

export function stateView(app: App) {
  return {
    mode: app.mode,
    business_date: BUSINESS_DATE,
    next_run_date: NEXT_RUN_DATE,
    facts_digest: app.facts.digest.slice(0, 12),
    investigating: [...app.investigating],
    extraction_missing: app.extractionMissing,
  };
}

export function queueView(app: App) {
  return app.issues.map((issue) => {
    const run = app.store.latestRun(issue.issue_id);
    const actions = run ? app.store.actions({ planId: run.run_id }) : [];
    const plan = run ? app.store.plan(run.run_id) : null;
    return {
      issue_id: issue.issue_id,
      type: issue.type,
      title: issue.title,
      vendor: vendorName(app.facts.db, issue.vendor_id),
      money_at_risk: formatCents(issue.money_at_risk_usd_cents),
      deadline: issue.deadline,
      ranking: issue.ranking,
      status: app.investigating.has(issue.issue_id) ? 'investigating' : !run ? 'not investigated' : run.status === 'failed' ? 'run failed' : plan?.outcome ?? 'planned',
      pending_actions: actions.filter((a) => a.status === 'proposed').length,
    };
  });
}

export function issueView(app: App, issueId: string) {
  const issue = app.issue(issueId);
  if (!issue) return null;
  const run = app.store.latestRun(issueId);
  const plan = run ? app.store.plan(run.run_id) : null;
  const actions = run ? app.store.actions({ planId: run.run_id }).map((a) => actionView(app, a)) : [];
  const evidenceIds = [...new Set([...issue.evidence_ids, ...(plan?.evidence_ids ?? [])])];
  return {
    issue: { ...issue, vendor: vendorName(app.facts.db, issue.vendor_id), money_at_risk: formatCents(issue.money_at_risk_usd_cents) },
    run: run && {
      run_id: run.run_id,
      mode: run.mode,
      status: run.status,
      failure: run.failure,
      model: run.model,
      tool_calls: run.tool_calls,
      cost_usd: run.cost_usd,
      duration_ms: run.duration_ms,
      trail: (JSON.parse(run.trail_json) as ToolCallRecord[]).map(trailStep),
    },
    plan,
    actions,
    evidence: evidenceIds.map((id) => evidenceCard(app.facts.db, id)).filter((c) => c !== null),
  };
}

export function approvalsView(app: App) {
  const db = app.store.db;
  return {
    pending: app.store.actions({ status: 'proposed' }).map((a) => ({ ...actionView(app, a), issue_title: app.issue(a.issue_id)?.title ?? a.issue_id })),
    outbox: db.all<{ outbox_id: number; action_id: string; kind: string; document_json: string; at: string }>('SELECT * FROM outbox ORDER BY outbox_id DESC').map((o) => ({ ...o, document: JSON.parse(o.document_json) })),
    activity: db.all('SELECT at, actor, event, detail FROM activity ORDER BY activity_id DESC LIMIT 40'),
  };
}

function actionView(app: App, a: ActionRow) {
  const payload = ActionSchema.parse(JSON.parse(a.payload_json));
  return { action_id: a.action_id, issue_id: a.issue_id, type: a.type, status: a.status, payload, payload_hash: a.payload_hash, document: renderDocument(payload, app.facts.db) };
}

function vendorName(db: Db, vendorId: string): string {
  return db.get<{ legal_name: string }>('SELECT legal_name FROM vendors WHERE vendor_id = ?', [vendorId])?.legal_name ?? vendorId;
}

function trailStep(c: ToolCallRecord) {
  const o = c.output as Record<string, unknown> | undefined;
  let result = c.error ? `refused: ${c.error}` : 'ok';
  if (!c.error && o && c.name === 'query') result = `${(o.rows as unknown[]).length} row(s)${o.truncated ? ', truncated' : ''}`;
  if (!c.error && o && c.name === 'match_check') result = `payable ${formatCents(o.payable_cents as number)}, disputed ${formatCents(o.disputed_cents as number)}, ${o.within_tolerance ? 'within' : 'outside'} tolerance`;
  if (!c.error && o && c.name === 'discount_value') result = o.eligible ? `discount ${formatCents(o.discount_cents as number)} by ${o.discount_deadline}, ${o.annualized_return_pct}% annualized` : `no discount: ${o.reason}`;
  if (!c.error && o && c.name === 'read_email') result = `${(o.trust_flags as unknown[]).length} trust flag(s)`;
  if (c.name === 'submit_plan') result = c.error ? `rejected: ${c.error}` : 'accepted';
  return { tool: c.name, input: c.name === 'submit_plan' ? '(plan)' : JSON.stringify(c.input), result, ok: !c.error };
}

type Card = { id: string; kind: string; title: string; fields: [string, string][]; table?: { head: string[]; rows: string[][] }; text?: string; flags?: { flag: string; detail: string }[] };

export function evidenceCard(db: Db, id: string): Card | null {
  if (/^AP-\d{2}-\d{4}$/.test(id)) {
    const inv = db.get<Record<string, string | number>>(
      'SELECT i.*, v.legal_name, b.open_cents FROM invoices i JOIN vendors v USING (vendor_id) JOIN invoice_balances b USING (invoice_id) WHERE invoice_id = ?',
      [id],
    );
    if (!inv) return null;
    const lines = db.all<Record<string, string | number | null>>('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no', [id]);
    return {
      id, kind: 'invoice', title: `Invoice ${id} · ${inv.legal_name}`,
      fields: [
        ['Vendor invoice no.', String(inv.vendor_invoice_no)], ['Invoice date', String(inv.invoice_date)], ['Due', String(inv.due_date)],
        ['Total', formatCents(Number(inv.total_cents), String(inv.currency))], ['Open', formatCents(Number(inv.open_cents), String(inv.currency))],
        ['Status', String(inv.status)], ['Received via', String(inv.received_via)], ['Source', String(inv.src)],
      ],
      table: { head: ['#', 'PO line', 'Description', 'Qty', 'Unit price', 'Line total'], rows: lines.map((l) => [String(l.line_no), String(l.po_line_id ?? '—'), String(l.description), `${l.quantity} ${l.unit}`, formatCents(Math.round(Number(l.unit_price_cents))), formatCents(Number(l.line_total_cents))]) },
    };
  }
  if (/^m\d{2}$/.test(id)) {
    const e = db.get<Record<string, string | null>>('SELECT * FROM emails WHERE email_id = ?', [id]);
    if (!e) return null;
    const flags = db.all<{ flag: string; detail: string }>('SELECT flag, detail FROM email_flags WHERE email_id = ?', [id]);
    return {
      id, kind: 'email', title: `Email ${id} · ${e.subject}`,
      fields: [['From', `${e.from_name} <${e.from_address}>`], ...(e.reply_to ? [['Reply-To', e.reply_to] as [string, string]] : []), ['Sent', String(e.sent_at)], ['Source', String(e.src)]],
      text: String(e.body), flags,
    };
  }
  if (/^PO-\d+-\d+$/.test(id)) {
    const l = db.get<Record<string, string | number>>('SELECT p.*, o.vendor_id, o.order_date, o.buyer FROM po_line_progress p JOIN purchase_orders o USING (po_id) WHERE po_line_id = ?', [id]);
    if (!l) return null;
    const receipts = db.all<Record<string, string | number>>('SELECT receipt_id, qty_received, date_received FROM receipts WHERE po_line_id = ? ORDER BY date_received', [id]);
    return {
      id, kind: 'po_line', title: `PO line ${id} · ${l.description}`,
      fields: [['Ordered', `${l.qty_ordered} ${l.unit} on ${l.order_date}`], ['PO price', `${formatCents(Number(l.unit_price_cents))} per ${l.unit}`], ['Received', `${l.qty_received} ${l.unit}`], ['Buyer', String(l.buyer)]],
      table: { head: ['Receipt', 'Qty', 'Date'], rows: receipts.map((r) => [String(r.receipt_id), String(r.qty_received), String(r.date_received)]) },
    };
  }
  if (/^R-\d+$/.test(id)) {
    const r = db.get<Record<string, string | number>>('SELECT * FROM receipts WHERE receipt_id = ?', [id]);
    return r ? { id, kind: 'receipt', title: `Receipt ${id}`, fields: [['PO line', String(r.po_line_id)], ['Quantity', String(r.qty_received)], ['Date', String(r.date_received)]] } : null;
  }
  return null;
}
