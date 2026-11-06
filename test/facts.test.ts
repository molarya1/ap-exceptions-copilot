import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFacts } from '../src/ingest/build';
import { scenario, sharedFacts } from './helpers';

test('two builds from the same data produce the same digest', async () => {
  const a = await buildFacts('data', new Map());
  const b = await buildFacts('data', new Map());
  assert.equal(a.digest, b.digest);
  assert.match(a.digest, /^[0-9a-f]{64}$/);
});

test('a changed fact changes the digest', async () => {
  const a = await sharedFacts();
  const b = await buildFacts('data', new Map(), { overlaySql: "UPDATE receipts SET qty_received = qty_received + 1 WHERE rowid = 1" });
  assert.notEqual(a.digest, b.digest);
});

test('facts.db refuses writes after the build', async () => {
  const { db } = await sharedFacts();
  assert.throws(() => db.run('DELETE FROM invoices'), /readonly/);
});

test('every kept invoice maps to a vendor and keeps a pointer to its source row', async () => {
  const { db } = await sharedFacts();
  const orphans = db.all('SELECT invoice_id FROM invoices WHERE vendor_id NOT IN (SELECT vendor_id FROM vendors)');
  assert.deepEqual(orphans, []);
  const noSrc = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM invoices WHERE src NOT LIKE 'invoices.csv:%'");
  assert.equal(noSrc?.n, 0);
});

test('the duplicate pair resolves to one vendor and one invoice-number key', async () => {
  const { db } = await sharedFacts();
  const ids = scenario('duplicate_invoice').invoice_ids;
  const rows = db.all<{ vendor_id: string; invoice_no_key: string }>(`SELECT vendor_id, invoice_no_key FROM invoices WHERE invoice_id IN (?, ?)`, ids);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.vendor_id, rows[1]!.vendor_id);
  assert.equal(rows[0]!.invoice_no_key, rows[1]!.invoice_no_key);
});

test('blank and malformed rows are skipped and logged', async () => {
  const { db } = await sharedFacts();
  const rules = db.all<{ rule: string }>("SELECT rule FROM cleaning_log WHERE rule IN ('blank_row', 'malformed_row')").map((r) => r.rule);
  assert.ok(rules.includes('blank_row'));
  assert.ok(rules.includes('malformed_row'));
  assert.equal(db.get("SELECT 1 FROM invoices WHERE invoice_id = 'AP-26-9001'"), undefined);
});

test('lines billed per each are converted to the PO unit', async () => {
  const { db } = await sharedFacts();
  const inv = scenario('discount_kestrel').invoice_ids[0]!;
  const line = db.get<{ unit: string; qty_in_po_unit: number; price_in_po_unit_cents: number }>('SELECT unit, qty_in_po_unit, price_in_po_unit_cents FROM invoice_lines WHERE invoice_id = ?', [inv]);
  assert.deepEqual(line, { unit: 'each', qty_in_po_unit: 150, price_in_po_unit_cents: 2640 });
});

test('credit notes and foreign currency are recorded', async () => {
  const { db } = await sharedFacts();
  assert.ok(db.get("SELECT 1 FROM invoices WHERE is_credit_note = 1 AND total_cents < 0"));
  const cad = db.get<{ total_cents: number; total_usd_cents: number }>("SELECT total_cents, total_usd_cents FROM invoices WHERE currency = 'CAD' LIMIT 1");
  assert.ok(cad && cad.total_usd_cents < cad.total_cents);
});

test('the look-alike sender and its Reply-To are flagged in code', async () => {
  const { db } = await sharedFacts();
  const email = scenario('bank_change_fraud').email_ids[0]!;
  const flags = db.all<{ flag: string }>('SELECT flag FROM email_flags WHERE email_id = ? ORDER BY flag', [email]).map((f) => f.flag);
  assert.deepEqual(flags, ['lookalike_domain', 'reply_to_mismatch']);
  const others = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM email_flags WHERE email_id <> ?', [email]);
  assert.equal(others?.n, 0);
});
