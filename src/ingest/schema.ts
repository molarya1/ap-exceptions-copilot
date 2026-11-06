// facts.db: rebuilt from data/ on every start, read-only afterwards.
// Money is integer cents. Every fact row keeps `src`, a pointer to its raw source.

export const FACTS_SCHEMA = `
CREATE TABLE vendors (
  vendor_id TEXT PRIMARY KEY, legal_name TEXT NOT NULL, trading_names TEXT NOT NULL,
  category TEXT NOT NULL, payment_terms TEXT NOT NULL,
  discount_pct REAL NOT NULL, discount_days INTEGER NOT NULL, net_days INTEGER NOT NULL,
  remit_account TEXT NOT NULL, contact_name TEXT NOT NULL, contact_phone TEXT NOT NULL,
  contact_email TEXT NOT NULL, email_domain TEXT NOT NULL, status TEXT NOT NULL, src TEXT NOT NULL
);
CREATE TABLE vendor_names (name_key TEXT PRIMARY KEY, vendor_id TEXT NOT NULL);
CREATE TABLE purchase_orders (
  po_id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL, order_date TEXT NOT NULL,
  buyer TEXT NOT NULL, currency TEXT NOT NULL, src TEXT NOT NULL
);
CREATE TABLE po_lines (
  po_line_id TEXT PRIMARY KEY, po_id TEXT NOT NULL, description TEXT NOT NULL, unit TEXT NOT NULL,
  qty_ordered REAL NOT NULL, unit_price_cents INTEGER NOT NULL, src TEXT NOT NULL
);
CREATE TABLE receipts (
  receipt_id TEXT PRIMARY KEY, po_line_id TEXT NOT NULL, qty_received REAL NOT NULL,
  date_received TEXT NOT NULL, src TEXT NOT NULL
);
CREATE TABLE invoices (
  invoice_id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL,
  vendor_invoice_no TEXT NOT NULL, invoice_no_key TEXT NOT NULL,
  invoice_date TEXT NOT NULL, due_date TEXT NOT NULL, currency TEXT NOT NULL,
  total_cents INTEGER NOT NULL, total_usd_cents INTEGER NOT NULL,
  status TEXT NOT NULL, is_credit_note INTEGER NOT NULL, received_via TEXT NOT NULL, src TEXT NOT NULL
);
CREATE TABLE invoice_lines (
  invoice_id TEXT NOT NULL, line_no INTEGER NOT NULL, po_line_id TEXT,
  description TEXT NOT NULL, unit TEXT NOT NULL, quantity REAL NOT NULL,
  unit_price_cents REAL NOT NULL, line_total_cents INTEGER NOT NULL,
  qty_in_po_unit REAL, price_in_po_unit_cents REAL, src TEXT NOT NULL,
  PRIMARY KEY (invoice_id, line_no)
);
CREATE TABLE payments (
  payment_id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  payment_date TEXT NOT NULL, paid_to_account TEXT NOT NULL, src TEXT NOT NULL
);
CREATE TABLE fx_rates (currency TEXT PRIMARY KEY, usd_per_unit REAL NOT NULL, as_of TEXT NOT NULL);
CREATE TABLE unit_conversions (
  item_description TEXT NOT NULL, from_unit TEXT NOT NULL, to_unit TEXT NOT NULL, factor REAL NOT NULL
);
CREATE TABLE emails (
  email_id TEXT PRIMARY KEY, sent_at TEXT NOT NULL, from_name TEXT NOT NULL, from_address TEXT NOT NULL,
  from_domain TEXT NOT NULL, reply_to TEXT, subject TEXT NOT NULL, body TEXT NOT NULL, src TEXT NOT NULL
);
CREATE TABLE email_extractions (
  email_id TEXT PRIMARY KEY, intent TEXT NOT NULL, summary TEXT NOT NULL,
  new_bank_account TEXT, new_bank_name TEXT, dropped_claims INTEGER NOT NULL
);
CREATE TABLE email_claims (
  email_id TEXT NOT NULL, claim_no INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, quote TEXT NOT NULL,
  PRIMARY KEY (email_id, claim_no)
);
CREATE TABLE email_flags (email_id TEXT NOT NULL, flag TEXT NOT NULL, detail TEXT NOT NULL, PRIMARY KEY (email_id, flag));
CREATE TABLE cleaning_log (
  log_id INTEGER PRIMARY KEY, rule TEXT NOT NULL, record TEXT NOT NULL,
  before TEXT NOT NULL, after TEXT NOT NULL, reason TEXT NOT NULL
);

CREATE VIEW invoice_balances AS
SELECT i.invoice_id, i.vendor_id, i.status, i.currency, i.total_cents,
       COALESCE(SUM(p.amount_cents), 0) AS paid_cents,
       i.total_cents - COALESCE(SUM(p.amount_cents), 0) AS open_cents
FROM invoices i LEFT JOIN payments p ON p.invoice_id = i.invoice_id
GROUP BY i.invoice_id;

CREATE VIEW po_line_progress AS
SELECT l.po_line_id, l.po_id, l.description, l.unit, l.qty_ordered, l.unit_price_cents,
       COALESCE((SELECT SUM(r.qty_received) FROM receipts r WHERE r.po_line_id = l.po_line_id), 0) AS qty_received
FROM po_lines l;
`;

/** Shown to the agent in the `query` tool description. Keep it in step with the schema. */
export const TABLE_GUIDE = `Tables (money is integer cents; dates are YYYY-MM-DD):
- vendors(vendor_id, legal_name, trading_names, category, payment_terms, discount_pct, discount_days, net_days, remit_account, contact_name, contact_phone, contact_email, email_domain, status)
- purchase_orders(po_id, vendor_id, order_date, buyer, currency)
- po_lines(po_line_id, po_id, description, unit, qty_ordered, unit_price_cents)
- receipts(receipt_id, po_line_id, qty_received, date_received)
- invoices(invoice_id, vendor_id, vendor_invoice_no, invoice_no_key, invoice_date, due_date, currency, total_cents, total_usd_cents, status [open|approved|paid|on_hold], is_credit_note, received_via)
- invoice_lines(invoice_id, line_no, po_line_id, description, unit, quantity, unit_price_cents, line_total_cents, qty_in_po_unit, price_in_po_unit_cents)
- payments(payment_id, invoice_id, amount_cents, payment_date, paid_to_account)
- emails(email_id, sent_at, from_name, from_address, from_domain, reply_to, subject) -- use read_email for the body
- email_extractions(email_id, intent, summary, new_bank_account, new_bank_name)
- email_claims(email_id, claim_no, kind, value, quote)
- email_flags(email_id, flag, detail)
- cleaning_log(rule, record, before, after, reason)
Views:
- invoice_balances(invoice_id, vendor_id, status, currency, total_cents, paid_cents, open_cents)
- po_line_progress(po_line_id, po_id, description, unit, qty_ordered, unit_price_cents, qty_received)
"approved" means the invoice is already in this week's payment run.`;
