import { toCsv } from '../lib/csv';
import { centsToDecimal } from '../lib/money';
import type { Rng } from '../lib/prng';
import type { Email, Invoice, Payment, Vendor, World } from './model';
import { invoiceTotalCents } from './model';

// Writes the clean model as an ERP export would look: inconsistent vendor names, invoice
// numbers and units, a few US-format dates, currency symbols, blank and malformed rows.

const LEGAL_SUFFIX = /,?\s+(LLC|Ltd|Inc|Co|S\.r\.l\.)$/;

function vendorNameVariant(rng: Rng, v: Vendor): string {
  const roll = rng.next();
  if (roll < 0.7) return v.legalName;
  if (roll < 0.82) return v.legalName.replace(LEGAL_SUFFIX, '').toUpperCase();
  if (roll < 0.94) {
    return v.legalName.replace('Packaging', 'Pkg').replace('Freight', 'Frt').replace('Service', 'Svc').replace(' & ', ' and ').replace(LEGAL_SUFFIX, ' $1.');
  }
  return v.tradingNames[0] ?? v.legalName;
}

function numberVariant(rng: Rng, n: string): string {
  const roll = rng.next();
  if (roll < 0.85) return n;
  if (roll < 0.93) return n.toLowerCase();
  return n.replace('-', ' ');
}

const usDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

function moneyVariant(rng: Rng, cents: number): string {
  if (!rng.chance(0.1)) return centsToDecimal(cents);
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

const UNIT_SPELLINGS: Record<string, string[]> = { each: ['EA', 'ea', 'Each'], case: ['CS', 'cs', 'Case'], roll: ['RL', 'Roll'] };

export function renderFiles(rng: Rng, world: World): Map<string, string> {
  const files = new Map<string, string>();
  const vendorById = new Map(world.vendors.map((v) => [v.id, v]));
  const terms = (t: string) => (rng.chance(0.2) ? t.replace('NET', 'Net ') : t);

  files.set('vendors.csv', toCsv(
    ['vendor_id', 'legal_name', 'trading_names', 'category', 'payment_terms', 'remit_to_account', 'contact_name', 'contact_phone', 'contact_email', 'email_domain', 'status'],
    world.vendors.map((v) => [v.id, v.legalName, v.tradingNames.join('; '), v.category, terms(v.terms), v.remitAccount, v.contactName, v.contactPhone, v.contactEmail, v.domain, v.status]),
  ));

  files.set('purchase_orders.csv', toCsv(['po_id', 'vendor_id', 'order_date', 'buyer', 'currency'], world.pos.map((p) => [p.id, p.vendorId, p.orderDate, p.buyer, p.currency])));
  files.set('po_lines.csv', toCsv(
    ['po_line_id', 'po_id', 'item_description', 'unit', 'qty_ordered', 'unit_price'],
    world.pos.flatMap((p) => p.lines.map((l) => [l.id, p.id, l.description, l.unit, l.qty, centsToDecimal(l.priceCents)])),
  ));
  files.set('receipts.csv', toCsv(['receipt_id', 'po_line_id', 'qty_received', 'date_received'], world.receipts.map((r) => [r.id, r.poLineId, r.qty, r.date])));

  const invoiceRows: (string | number)[][] = world.invoices.map((inv: Invoice) => {
    const v = vendorById.get(inv.vendorId)!;
    let currency: string = inv.currency;
    if (currency === 'USD' && rng.chance(0.1)) currency = '';
    else if (currency !== 'USD' && rng.chance(0.5)) currency = currency.toLowerCase();
    return [
      inv.id,
      inv.printedVendorName ?? vendorNameVariant(rng, v),
      inv.printedNumber ?? numberVariant(rng, inv.number),
      rng.chance(0.08) ? usDate(inv.date) : inv.date,
      inv.dueDate,
      currency,
      moneyVariant(rng, invoiceTotalCents(inv)),
      inv.status,
      inv.receivedVia,
    ];
  });
  invoiceRows.splice(Math.floor(invoiceRows.length / 3), 0, ['', '', '', '', '', '', '', '', '']);
  invoiceRows.splice(Math.floor((invoiceRows.length * 2) / 3), 0, ['AP-26-9001', 'Sutter Pallet Works', 'SP-PENDING', '2026-03-12', '', 'USD', 'see attached', 'open', 'mail']);
  files.set('invoices.csv', toCsv(['invoice_id', 'vendor', 'vendor_invoice_number', 'invoice_date', 'due_date', 'currency', 'total', 'status', 'received_via'], invoiceRows));

  const lineRows: (string | number)[][] = world.invoices.flatMap((inv) =>
    inv.lines.map((l, i) => {
      const unit = UNIT_SPELLINGS[l.unit] && rng.chance(0.15) ? rng.pick(UNIT_SPELLINGS[l.unit]!) : l.unit;
      return [inv.id, i + 1, l.poLineId ?? '', l.description, unit, l.qty, centsToDecimal(l.priceCents), centsToDecimal(l.qty * l.priceCents)];
    }),
  );
  lineRows.splice(Math.floor(lineRows.length / 2), 0, ['', '', '', '', '', '', '', '']);
  files.set('invoice_lines.csv', toCsv(['invoice_id', 'line_no', 'po_line_id', 'description', 'unit', 'quantity', 'unit_price', 'line_total'], lineRows));

  files.set('payments.csv', toCsv(
    ['payment_id', 'invoice_id', 'amount', 'payment_date', 'paid_to_account'],
    world.payments.map((p: Payment, i) => [`PAY-${String(i + 1).padStart(4, '0')}`, p.invoice.id, centsToDecimal(p.amountCents), p.date, p.account]),
  ));

  files.set('fx_rates.csv', toCsv(['currency', 'usd_per_unit', 'as_of'], [['USD', '1.0000', '2026-03-13'], ['CAD', '0.7310', '2026-03-13'], ['EUR', '1.0825', '2026-03-13']]));
  files.set('unit_conversions.csv', toCsv(
    ['item_description', 'from_unit', 'to_unit', 'factor'],
    [['Produce tray, molded pulp', 'case', 'each', 24], ['Yellow onions, 50 lb', 'sack', 'lb', 50]],
  ));

  for (const e of world.emails) files.set(`inbox/${e.id}-${e.slug}.eml`, renderEmail(e));
  return files;
}

function rfc2822(date: string, time: string): string {
  const d = new Date(`${date}T${time}:00Z`);
  const day = d.toUTCString().slice(0, 16); // "Mon, 09 Mar 2026"
  const offset = date >= '2026-03-08' ? '-0700' : '-0800'; // Pacific time, DST from March 8
  return `${day} ${time}:00 ${offset}`;
}

export function renderEmail(e: Email): string {
  const headers = [
    `Message-ID: <${e.id}.${e.date.replaceAll('-', '')}@${e.fromAddress.split('@')[1]}>`,
    `Date: ${rfc2822(e.date, e.time)}`,
    `From: "${e.fromName}" <${e.fromAddress}>`,
    ...(e.replyTo ? [`Reply-To: ${e.replyTo}`] : []),
    'To: ap@quillfeather.example',
    `Subject: ${e.subject}`,
    'Content-Type: text/plain; charset=utf-8',
  ];
  return `${headers.join('\n')}\n\n${e.body}\n`;
}
