import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRecords } from '../lib/csv';
import { hashJson } from '../lib/hash';
import type { Db } from '../lib/sqlite';
import { openDb } from '../lib/sqlite';
import { parseTerms } from '../lib/terms';
import { claimedBankAccount } from '../extract/verify';
import type { VerifiedExtraction } from '../extract/schema';
import { trustFlags } from '../extract/trust';
import { cleanCurrency, cleanDate, CleaningLog, cleanInvoiceNumber, cleanMoney, cleanTerms, cleanUnit, matchVendor, vendorNameKey } from './clean';
import type { ParsedEmail } from './email';
import { parseEml } from './email';
import { FACTS_SCHEMA } from './schema';

// data/ -> facts.db. Never writes to data/. Rebuilt from scratch on every start.

export interface Facts {
  db: Db;
  digest: string;
}

export function loadInbox(dataDir: string): ParsedEmail[] {
  const dir = join(dataDir, 'inbox');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.eml'))
    .sort()
    .map((f) => parseEml(`inbox/${f}`, readFileSync(join(dir, f), 'utf8')));
}

const isBlank = (values: Record<string, string>) => Object.values(values).every((v) => v.trim() === '');

export async function buildFacts(dataDir: string, extractions: Map<string, VerifiedExtraction>, opts: { overlaySql?: string } = {}): Promise<Facts> {
  const db = await openDb();
  db.exec(FACTS_SCHEMA);
  const log = new CleaningLog();
  const csv = (name: string) => readRecords(readFileSync(join(dataDir, name), 'utf8'));
  const insert = (table: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    db.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, Object.values(row) as never);
  };

  db.transaction(() => {
    // Vendors, and every name a vendor goes by, as a normalized key.
    const nameKeys = new Map<string, string>();
    const legalNames = new Map<string, string>();
    const vendorCurrency = new Map<string, string>();
    for (const { line, values: v } of csv('vendors.csv')) {
      const src = `vendors.csv:${line}`;
      if (isBlank(v)) continue;
      const terms = cleanTerms(log, src, v.payment_terms!);
      const parsed = parseTerms(terms);
      if (!parsed) {
        log.add('malformed_row', src, v.payment_terms!, '', 'unreadable payment terms; vendor skipped');
        continue;
      }
      insert('vendors', {
        vendor_id: v.vendor_id, legal_name: v.legal_name, trading_names: v.trading_names, category: v.category, payment_terms: terms,
        discount_pct: parsed.discountPct, discount_days: parsed.discountDays, net_days: parsed.netDays, remit_account: v.remit_to_account,
        contact_name: v.contact_name, contact_phone: v.contact_phone, contact_email: v.contact_email, email_domain: v.email_domain, status: v.status, src,
      });
      legalNames.set(v.vendor_id!, v.legal_name!);
      for (const name of [v.legal_name!, ...v.trading_names!.split(';')].map((n) => n.trim()).filter(Boolean)) {
        nameKeys.set(vendorNameKey(name), v.vendor_id!);
      }
    }
    for (const [key, id] of nameKeys) insert('vendor_names', { name_key: key, vendor_id: id });

    for (const { line, values: v } of csv('purchase_orders.csv')) {
      if (isBlank(v)) continue;
      insert('purchase_orders', { po_id: v.po_id, vendor_id: v.vendor_id, order_date: v.order_date, buyer: v.buyer, currency: v.currency, src: `purchase_orders.csv:${line}` });
      vendorCurrency.set(v.vendor_id!, v.currency!);
    }
    const poLines = new Map<string, { description: string; unit: string }>();
    for (const { line, values: v } of csv('po_lines.csv')) {
      if (isBlank(v)) continue;
      const src = `po_lines.csv:${line}`;
      const unit = cleanUnit(log, src, v.unit!);
      insert('po_lines', { po_line_id: v.po_line_id, po_id: v.po_id, description: v.item_description, unit, qty_ordered: Number(v.qty_ordered), unit_price_cents: cleanMoney(log, src, v.unit_price!), src });
      poLines.set(v.po_line_id!, { description: v.item_description!, unit });
    }
    for (const { line, values: v } of csv('receipts.csv')) {
      if (isBlank(v)) continue;
      insert('receipts', { receipt_id: v.receipt_id, po_line_id: v.po_line_id, qty_received: Number(v.qty_received), date_received: v.date_received, src: `receipts.csv:${line}` });
    }

    const fx = new Map<string, number>();
    for (const { values: v } of csv('fx_rates.csv')) {
      insert('fx_rates', { currency: v.currency, usd_per_unit: Number(v.usd_per_unit), as_of: v.as_of });
      fx.set(v.currency!, Number(v.usd_per_unit));
    }
    const conversions = new Map<string, number>();
    for (const { values: v } of csv('unit_conversions.csv')) {
      insert('unit_conversions', { item_description: v.item_description, from_unit: v.from_unit, to_unit: v.to_unit, factor: Number(v.factor) });
      conversions.set(`${v.item_description}|${v.from_unit}|${v.to_unit}`, Number(v.factor));
    }

    // Invoices: match the printed vendor name, normalize numbers, dates, money and currency.
    const kept = new Set<string>();
    for (const { line, values: v } of csv('invoices.csv')) {
      const src = `invoices.csv:${line}`;
      if (isBlank(v)) {
        log.add('blank_row', src, '', '', 'empty row skipped');
        continue;
      }
      const vendorId = matchVendor(log, src, v.vendor!, nameKeys, legalNames);
      const total = cleanMoney(log, src, v.total!);
      const invoiceDate = cleanDate(log, src, v.invoice_date!);
      const dueDate = cleanDate(log, src, v.due_date!);
      if (!vendorId || total === null || !invoiceDate || !dueDate) {
        log.add('malformed_row', src, JSON.stringify(v), '', 'missing or unreadable vendor, total or dates; row skipped');
        continue;
      }
      const currency = cleanCurrency(log, src, v.currency!, vendorCurrency.get(vendorId) ?? 'USD');
      const rate = fx.get(currency);
      if (rate === undefined) {
        log.add('malformed_row', src, currency, '', 'no FX rate for currency; row skipped');
        continue;
      }
      if (total < 0) log.add('credit_note', src, String(total), 'is_credit_note=1', 'negative total recorded as a credit note');
      insert('invoices', {
        invoice_id: v.invoice_id, vendor_id: vendorId, vendor_invoice_no: v.vendor_invoice_number, invoice_no_key: cleanInvoiceNumber(log, src, v.vendor_invoice_number!),
        invoice_date: invoiceDate, due_date: dueDate, currency, total_cents: total, total_usd_cents: Math.round(total * rate),
        status: v.status, is_credit_note: total < 0 ? 1 : 0, received_via: v.received_via, src,
      });
      kept.add(v.invoice_id!);
    }

    // Invoice lines: convert to the PO line's unit when the vendor bills in another unit.
    const noPo = new Set<string>();
    const withPo = new Set<string>();
    for (const { line, values: v } of csv('invoice_lines.csv')) {
      const src = `invoice_lines.csv:${line}`;
      if (isBlank(v)) {
        log.add('blank_row', src, '', '', 'empty row skipped');
        continue;
      }
      if (!kept.has(v.invoice_id!)) {
        log.add('orphan_line', src, v.invoice_id!, '', 'invoice was skipped; line skipped');
        continue;
      }
      const unit = cleanUnit(log, src, v.unit!);
      const qty = Number(v.quantity);
      const price = Math.round(Number(v.unit_price) * 10_000) / 100; // cents, may be fractional
      let qtyPo: number | null = null;
      let pricePo: number | null = null;
      const po = v.po_line_id ? poLines.get(v.po_line_id) : undefined;
      if (po) {
        withPo.add(v.invoice_id!);
        if (po.unit === unit) {
          qtyPo = qty;
          pricePo = price;
        } else {
          const factor = conversions.get(`${po.description}|${po.unit}|${unit}`);
          if (factor) {
            qtyPo = qty / factor;
            pricePo = Math.round(price * factor * 100) / 100;
            log.add('unit_conversion', src, `${qty} ${unit} @ ${price}c`, `${qtyPo} ${po.unit} @ ${pricePo}c`, `1 ${po.unit} = ${factor} ${unit}`);
          } else {
            log.add('unit_unresolved', src, unit, '', `no conversion from ${po.unit} to ${unit}`);
          }
        }
      } else {
        noPo.add(v.invoice_id!);
      }
      insert('invoice_lines', {
        invoice_id: v.invoice_id, line_no: Number(v.line_no), po_line_id: v.po_line_id || null, description: v.description, unit, quantity: qty,
        unit_price_cents: price, line_total_cents: cleanMoney(log, src, v.line_total!), qty_in_po_unit: qtyPo, price_in_po_unit_cents: pricePo, src,
      });
    }
    for (const id of [...noPo].filter((i) => !withPo.has(i)).sort()) {
      log.add('no_po_exempt', id, '', 'exempt from matching', 'no PO lines (utility, service or credit note)');
    }

    for (const { line, values: v } of csv('payments.csv')) {
      if (isBlank(v)) continue;
      const src = `payments.csv:${line}`;
      insert('payments', { payment_id: v.payment_id, invoice_id: v.invoice_id, amount_cents: cleanMoney(log, src, v.amount!), payment_date: v.payment_date, paid_to_account: v.paid_to_account, src });
    }

    // Emails, the verified extractions, and trust flags computed in code.
    const known = db.all<{ domain: string; vendorId: string; name: string }>('SELECT email_domain AS domain, vendor_id AS vendorId, legal_name AS name FROM vendors');
    for (const email of loadInbox(dataDir)) {
      insert('emails', {
        email_id: email.emailId, sent_at: email.sentAt, from_name: email.fromName, from_address: email.fromAddress, from_domain: email.fromDomain,
        reply_to: email.replyTo, subject: email.subject, body: email.body, src: email.file,
      });
      const x = extractions.get(email.emailId);
      if (x) {
        const bank = claimedBankAccount(x);
        insert('email_extractions', { email_id: email.emailId, intent: x.intent, summary: x.summary, new_bank_account: bank?.account ?? null, new_bank_name: bank?.bank ?? null, dropped_claims: x.droppedClaims });
        x.claims.forEach((c, i) => insert('email_claims', { email_id: email.emailId, claim_no: i + 1, kind: c.kind, value: c.value, quote: c.quote }));
      }
      for (const f of trustFlags(email, known, x)) insert('email_flags', { email_id: email.emailId, flag: f.flag, detail: f.detail });
    }

    log.entries.forEach((e) => insert('cleaning_log', { ...e }));
  });

  if (opts.overlaySql) db.exec(opts.overlaySql); // evals only: a small, known change to the facts
  const digest = contentDigest(db);
  db.makeReadOnly();
  return { db, digest };
}

/** Hash of every table's rows in a fixed order. Equal data, equal digest. */
export function contentDigest(db: Db): string {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => t.name);
  const content = tables.map((t) => {
    const cols = db.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
    return [t, db.all(`SELECT * FROM ${t} ORDER BY ${cols.join(', ')}`)];
  });
  return hashJson(content);
}
