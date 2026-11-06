import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCurrency, cleanDate, CleaningLog, cleanMoney, cleanUnit, invoiceNumberKey, vendorNameKey } from '../src/ingest/clean';
import { parseTerms } from '../src/lib/terms';

test('vendor names normalize across case, abbreviations and legal suffixes', () => {
  const key = vendorNameKey('Harlow Packaging Ltd');
  assert.equal(vendorNameKey('HARLOW PACKAGING'), key);
  assert.equal(vendorNameKey('Harlow Pkg'), key);
  assert.equal(vendorNameKey('Harlow Pkg Ltd.'), key);
  assert.equal(vendorNameKey('Pell and Hart Equipment Svc LLC.'), vendorNameKey('Pell & Hart Equipment Service LLC'));
  assert.notEqual(vendorNameKey('Harlow Freight'), key);
});

test('invoice numbers compare on a normalized key', () => {
  assert.equal(invoiceNumberKey('INV-00412'), '412');
  assert.equal(invoiceNumberKey('inv 412'), '412');
  assert.equal(invoiceNumberKey('412'), '412');
  assert.equal(invoiceNumberKey('cvd-55821'), 'CVD55821');
  assert.equal(invoiceNumberKey('LP 6333'), 'LP6333');
  assert.notEqual(invoiceNumberKey('INV-00412'), invoiceNumberKey('INV-00413'));
});

test('money, dates, currency and units are cleaned and logged', () => {
  const log = new CleaningLog();
  assert.equal(cleanMoney(log, 'r1', '$1,234.50'), 123450);
  assert.equal(cleanMoney(log, 'r2', '-180.00'), -18000);
  assert.equal(cleanMoney(log, 'r3', 'see attached'), null);
  assert.equal(cleanDate(log, 'r4', '03/09/2026'), '2026-03-09');
  assert.equal(cleanDate(log, 'r5', '13/45/2026'), null);
  assert.equal(cleanCurrency(log, 'r6', '', 'CAD'), 'CAD');
  assert.equal(cleanCurrency(log, 'r7', 'eur', 'USD'), 'EUR');
  assert.equal(cleanUnit(log, 'r8', 'CS'), 'case');
  assert.equal(cleanUnit(log, 'r9', 'ea.'), 'each');
  assert.deepEqual(log.entries.map((e) => e.rule), ['money_format', 'date_format', 'currency_default', 'currency_case', 'unit_name', 'unit_name']);
});

test('payment terms parse discounts', () => {
  assert.deepEqual(parseTerms('2/10 NET30'), { discountPct: 0.02, discountDays: 10, netDays: 30 });
  assert.deepEqual(parseTerms('Net 45'), { discountPct: 0, discountDays: 0, netDays: 45 });
  assert.equal(parseTerms('whenever'), null);
});
