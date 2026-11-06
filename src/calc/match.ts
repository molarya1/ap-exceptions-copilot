import { MATCH_TOLERANCE } from '../config';
import type { Db } from '../lib/sqlite';

// Three-way match in code: invoice line vs PO line (price) vs receipts (quantity).
// The agent cannot do this arithmetic itself; payment amounts must come from here.

export interface MatchLine {
  line_no: number;
  po_line_id: string | null;
  description: string;
  billed_qty: number | null; // in the PO line's unit
  billed_price_cents: number | null; // per PO unit
  billed_cents: number;
  po_price_cents: number | null;
  qty_received: number | null;
  qty_already_paid: number | null; // on other, already paid invoices
  payable_cents: number;
  variance_cents: number;
  variance_pct: number;
  within_tolerance: boolean;
  note: string;
}

export interface MatchResult {
  invoice_id: string;
  vendor_id: string;
  currency: string;
  status: string;
  invoice_total_cents: number;
  open_cents: number;
  exempt: boolean;
  within_tolerance: boolean;
  payable_cents: number; // what the evidence supports paying now
  disputed_cents: number; // open balance minus payable
  lines: MatchLine[];
  tolerance: string;
}

interface LineRow {
  line_no: number;
  po_line_id: string | null;
  description: string;
  qty_in_po_unit: number | null;
  price_in_po_unit_cents: number | null;
  line_total_cents: number;
  po_price: number | null;
  qty_ordered: number | null;
  qty_received: number | null;
}

const TOLERANCE_TEXT = `a line is an exception only when it is over by more than ${MATCH_TOLERANCE.pct * 100}% and more than $${MATCH_TOLERANCE.cents / 100}`;

export function matchCheck(db: Db, invoiceId: string): MatchResult | null {
  const inv = db.get<{ vendor_id: string; currency: string; status: string; total_cents: number; open_cents: number; is_credit_note: number }>(
    `SELECT i.vendor_id, i.currency, i.status, i.total_cents, b.open_cents, i.is_credit_note
     FROM invoices i JOIN invoice_balances b USING (invoice_id) WHERE i.invoice_id = ?`,
    [invoiceId],
  );
  if (!inv) return null;

  const rows = db.all<LineRow>(
    `SELECT l.line_no, l.po_line_id, l.description, l.qty_in_po_unit, l.price_in_po_unit_cents, l.line_total_cents,
            p.unit_price_cents AS po_price, p.qty_ordered, p.qty_received
     FROM invoice_lines l LEFT JOIN po_line_progress p ON p.po_line_id = l.po_line_id
     WHERE l.invoice_id = ? ORDER BY l.line_no`,
    [invoiceId],
  );
  const base = { invoice_id: invoiceId, vendor_id: inv.vendor_id, currency: inv.currency, status: inv.status, invoice_total_cents: inv.total_cents, open_cents: inv.open_cents, tolerance: TOLERANCE_TEXT };

  const exempt = inv.is_credit_note === 1 || rows.every((r) => !r.po_line_id);
  if (exempt) {
    const lines = rows.map((r) => line(r, { payable: r.line_total_cents, note: 'no PO line: exempt from matching' }));
    return { ...base, exempt: true, within_tolerance: true, payable_cents: inv.open_cents, disputed_cents: 0, lines };
  }

  const lines = rows.map((r): MatchLine => {
    if (!r.po_line_id) return line(r, { payable: r.line_total_cents, note: 'no PO line: paid as billed' });
    if (r.qty_in_po_unit === null || r.price_in_po_unit_cents === null || r.po_price === null) {
      return line(r, { payable: 0, note: 'unit could not be converted to the PO unit; cannot match' });
    }
    const alreadyPaid = paidQty(db, r.po_line_id, invoiceId);
    const allowedQty = Math.max(0, Math.min(r.qty_received ?? 0, r.qty_ordered ?? 0) - alreadyPaid);
    const payQty = Math.min(r.qty_in_po_unit, allowedQty);
    const payPrice = Math.min(r.price_in_po_unit_cents, r.po_price);
    const payable = Math.min(r.line_total_cents, Math.round(payQty * payPrice));
    const notes: string[] = [];
    if (r.qty_in_po_unit > allowedQty) notes.push(`billed ${r.qty_in_po_unit}, received and not yet paid ${allowedQty}`);
    if (r.price_in_po_unit_cents > r.po_price) notes.push(`price ${r.price_in_po_unit_cents}c vs PO ${r.po_price}c`);
    return line(r, { payable, alreadyPaid, note: notes.join('; ') || 'matches PO and receipts' });
  });

  const within = lines.every((l) => l.within_tolerance);
  const payable = within ? inv.open_cents : Math.max(0, lines.reduce((s, l) => s + l.payable_cents, 0) - (inv.total_cents - inv.open_cents));
  return { ...base, exempt: false, within_tolerance: within, payable_cents: payable, disputed_cents: inv.open_cents - payable, lines };
}

function line(r: LineRow, o: { payable: number; note: string; alreadyPaid?: number }): MatchLine {
  const variance = r.line_total_cents - o.payable;
  const pct = r.line_total_cents > 0 ? variance / r.line_total_cents : 0;
  return {
    line_no: r.line_no,
    po_line_id: r.po_line_id,
    description: r.description,
    billed_qty: r.qty_in_po_unit,
    billed_price_cents: r.price_in_po_unit_cents,
    billed_cents: r.line_total_cents,
    po_price_cents: r.po_price,
    qty_received: r.qty_received,
    qty_already_paid: o.alreadyPaid ?? null,
    payable_cents: o.payable,
    variance_cents: variance,
    variance_pct: Math.round(pct * 10_000) / 10_000,
    within_tolerance: variance <= MATCH_TOLERANCE.cents || pct <= MATCH_TOLERANCE.pct,
    note: o.note,
  };
}

/** Quantity of a PO line already billed on other invoices that have been paid. */
function paidQty(db: Db, poLineId: string, exceptInvoice: string): number {
  const row = db.get<{ q: number | null }>(
    `SELECT SUM(l.qty_in_po_unit) AS q FROM invoice_lines l JOIN invoices i USING (invoice_id)
     WHERE l.po_line_id = ? AND i.invoice_id <> ? AND i.status = 'paid' AND i.is_credit_note = 0`,
    [poLineId, exceptInvoice],
  );
  return row?.q ?? 0;
}
