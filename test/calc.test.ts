import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discountValue } from '../src/calc/discount';
import { matchCheck } from '../src/calc/match';
import { facts, scenario, sharedFacts } from './helpers';

test('price variance: payable at PO price, overcharge disputed', async () => {
  const { db } = await sharedFacts();
  const s = scenario('price_variance');
  const m = matchCheck(db, s.invoice_ids[0]!)!;
  assert.equal(m.within_tolerance, false);
  assert.equal(m.disputed_cents, s.facts.overbilled_cents);
  assert.equal(m.payable_cents, m.open_cents - Number(s.facts.overbilled_cents));
  const bad = m.lines.filter((l) => !l.within_tolerance);
  assert.equal(bad.length, 1);
  assert.equal(bad[0]!.po_line_id, s.facts.po_line_id);
});

test('quantity variance: payable for received quantity only', async () => {
  const { db } = await sharedFacts();
  const s = scenario('quantity_variance');
  const m = matchCheck(db, s.invoice_ids[0]!)!;
  assert.equal(m.payable_cents, 160 * 2150);
  assert.equal(m.disputed_cents, 40 * 2150);
});

test('small variances inside tolerance are paid as billed', async () => {
  const s = scenario('price_variance');
  // +$0.30 a case on 300 cases: $90 over, but only 1.6%, so within tolerance.
  const { db } = await facts(new Map(), `UPDATE invoice_lines SET price_in_po_unit_cents = 1870, unit_price_cents = 1870, line_total_cents = 561000 WHERE invoice_id = '${s.invoice_ids[0]}' AND line_no = 1;
    UPDATE invoices SET total_cents = total_cents - 595500 + 561000 WHERE invoice_id = '${s.invoice_ids[0]}';`);
  const m = matchCheck(db, s.invoice_ids[0]!)!;
  assert.equal(m.within_tolerance, true);
  assert.equal(m.payable_cents, m.open_cents);
});

test('unit conversion lets a per-each invoice match a per-case PO', async () => {
  const { db } = await sharedFacts();
  const m = matchCheck(db, scenario('discount_kestrel').invoice_ids[0]!)!;
  assert.equal(m.within_tolerance, true);
  assert.equal(m.payable_cents, 396000);
});

test('utility invoices without a PO are exempt', async () => {
  const { db } = await sharedFacts();
  const id = db.get<{ invoice_id: string }>("SELECT invoice_id FROM invoice_lines GROUP BY invoice_id HAVING MAX(po_line_id) IS NULL LIMIT 1")!.invoice_id;
  const m = matchCheck(db, id)!;
  assert.equal(m.exempt, true);
  assert.equal(m.payable_cents, m.open_cents);
});

test('discount value: 2% of the payable amount, annualized return, deadline', async () => {
  const { db } = await sharedFacts();
  const s = scenario('discount_juniper');
  const d = discountValue(db, s.invoice_ids[0]!)!;
  assert.equal(d.eligible, true);
  assert.equal(d.discount_cents, s.facts.discount_cents);
  assert.equal(d.pay_with_discount_cents, 1_240_000 - 24_800);
  assert.equal(d.discount_deadline, s.facts.deadline);
  assert.equal(d.annualized_return_pct, 37.2);
  assert.equal(d.must_pay_this_run_to_capture, true);
});

test('no discount for vendors without discount terms, or after the window', async () => {
  const { db } = await sharedFacts();
  assert.equal(discountValue(db, scenario('price_variance').invoice_ids[0]!)!.eligible, false);
  const expired = db.get<{ invoice_id: string }>("SELECT i.invoice_id FROM invoices i JOIN vendors v USING (vendor_id) WHERE v.discount_days > 0 AND i.status = 'open' AND date(i.invoice_date, '+10 days') < '2026-03-16' LIMIT 1")!;
  const d = discountValue(db, expired.invoice_id)!;
  assert.equal(d.eligible, false);
  assert.match(d.reason, /closed/);
});

test('unknown invoices return null', async () => {
  const { db } = await sharedFacts();
  assert.equal(matchCheck(db, 'AP-26-0000'), null);
  assert.equal(discountValue(db, 'AP-26-0000'), null);
});
