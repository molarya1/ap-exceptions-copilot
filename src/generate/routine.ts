import { BUSINESS_DATE, NEXT_RUN_DATE } from '../config';
import { addDays, daysBetween } from '../lib/dates';
import type { Rng } from '../lib/prng';
import { parseTerms } from '../lib/terms';
import type { Invoice, InvoiceLine, Payment, PurchaseOrder, Receipt, Vendor, World } from './model';
import { invoiceTotalCents } from './model';
import { BUYERS } from './vendors';

// Routine business: purchase orders that were received and invoiced exactly as ordered.
// None of this should produce an issue. The scenarios add the problems on top.

interface Product {
  description: string;
  unit: string;
  minCents: number;
  maxCents: number;
  minQty: number;
  maxQty: number;
  /** Optional: the vendor bills this item in a smaller unit (see unit_conversions.csv). */
  billedAs?: { unit: string; factor: number };
}

const P = (description: string, unit: string, minCents: number, maxCents: number, minQty: number, maxQty: number, billedAs?: Product['billedAs']): Product => ({ description, unit, minCents, maxCents, minQty, maxQty, billedAs });

const CATALOG: Record<string, Product[]> = {
  growers: [
    P('Roma tomatoes, 25 lb', 'case', 1650, 2100, 80, 300),
    P('Green bell peppers, 25 lb', 'case', 1900, 2600, 60, 200),
    P('Gala apples, 40 lb', 'case', 2800, 3600, 80, 400),
    P('Russet potatoes, 50 lb', 'sack', 1500, 2200, 100, 400),
    P('Romaine hearts, 12 ct', 'case', 2400, 3200, 50, 250),
    P('Carrots, 25 lb', 'case', 1200, 1700, 80, 300),
    P('Lemons, 115 ct', 'case', 3000, 4200, 40, 160),
    P('Spring mix, 3 lb', 'case', 1400, 1900, 60, 240),
  ],
  calder: [P('Whole milk, 4 x 1 gal', 'case', 2050, 2250, 120, 240), P('Unsalted butter, 36 x 1 lb', 'case', 9800, 11200, 20, 60)],
  tolland: [P('Large eggs, 15 dozen', 'case', 3200, 4100, 60, 200)],
  hollis: [P('Cremini mushrooms, 10 lb', 'case', 2600, 3300, 40, 160)],
  reddmesa: [P('Yellow onions, 50 lb', 'sack', 1800, 2400, 100, 300, { unit: 'lb', factor: 50 })],
  copperfield: [P('Lemons, 115 ct', 'case', 3000, 4200, 40, 160), P('Navel oranges, 88 ct', 'case', 2600, 3400, 60, 220)],
  juniper: [P('Gala apples, 40 lb', 'case', 2800, 3600, 120, 400), P('Bartlett pears, 44 lb', 'case', 3400, 4000, 60, 180)],
  packaging: [
    P('Corrugated shipper box 18x12x10', 'each', 55, 78, 1500, 6000),
    P('Stretch wrap, 18 in x 1500 ft', 'roll', 2200, 2900, 40, 160),
    P('Pallet label roll, 4x6', 'roll', 1800, 2600, 20, 80),
    P('Clamshell, 1 lb vented', 'case', 3900, 5200, 30, 120),
  ],
  kestrel: [P('Produce tray, molded pulp', 'case', 2400, 3600, 50, 200, { unit: 'each', factor: 24 }), P('Corrugated shipper box 18x12x10', 'each', 55, 78, 1500, 5000)],
  sutter: [P('Pallet, 48x40 heat treated', 'each', 1100, 1500, 100, 400)],
  freight: [
    P('Reefer load, Stockton to Quillfeather DC', 'load', 145000, 185000, 2, 6),
    P('LTL pallet delivery, regional', 'pallet', 6500, 9500, 10, 40),
  ],
  fenwick: [P('Cold storage, pallet-week', 'pallet-week', 1800, 2400, 120, 400)],
  equipment_service: [
    P('Refrigeration unit service visit', 'visit', 38000, 62000, 1, 4),
    P('Forklift preventive maintenance', 'visit', 24000, 36000, 1, 3),
    P('Technician labor', 'hour', 9500, 13500, 4, 24),
  ],
};

const UTILITY_LINES: Record<string, [string, number, number][]> = {
  larchmont: [['Electricity service, DC and offices', 1_850_000, 2_400_000]],
  tamsin: [['Water and sewer service', 210_000, 340_000]],
  northgate: [['Waste collection', 160_000, 220_000], ['Recycling pickup', 40_000, 70_000]],
  brandt: [['Telecom and internet service', 120_000, 150_000]],
};

const MONTHS = ['Jan', 'Feb', 'Mar'];

export class Ids {
  private counters = new Map<string, number>();
  next(prefix: string, start: number, width: number): string {
    const n = (this.counters.get(prefix) ?? start - 1) + 1;
    this.counters.set(prefix, n);
    return `${prefix}${String(n).padStart(width, '0')}`;
  }
}

/** Mondays are payment-run days. Returns the latest run on or before `iso`. */
export function runOnOrBefore(iso: string): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 Sunday .. 6 Saturday
  return addDays(iso, -((dow + 6) % 7));
}

/** Status the ERP would show today for a routine invoice, from its due date. */
export function routineStatus(dueDate: string): Invoice['status'] {
  if (dueDate < BUSINESS_DATE) return 'paid';
  if (dueDate < NEXT_RUN_DATE) return 'approved';
  return 'open';
}

export function vendorPrefix(v: Vendor): string {
  return v.legalName.slice(0, 3).toUpperCase();
}

export function buildRoutine(rng: Rng, vendors: Map<string, Vendor>, ids: Ids): Pick<World, 'pos' | 'receipts' | 'invoices'> {
  const pos: PurchaseOrder[] = [];
  const receipts: Receipt[] = [];
  const invoices: Invoice[] = [];
  const numbers = new Map<string, number>();
  const nextNumber = (v: Vendor) => {
    const n = (numbers.get(v.id) ?? rng.int(1000, 8000)) + rng.int(3, 40);
    numbers.set(v.id, n);
    return `${vendorPrefix(v)}-${n}`;
  };

  for (const [key, vendor] of vendors) {
    if (vendor.status !== 'active') continue;
    const terms = parseTerms(vendor.terms)!;

    if (vendor.category === 'utilities') {
      for (let m = 0; m < MONTHS.length; m++) {
        const date = `2026-0${m + 1}-0${rng.int(1, 4)}`;
        invoices.push({
          id: '', vendorId: vendor.id, number: nextNumber(vendor), date, dueDate: addDays(date, terms.netDays),
          currency: vendor.currency, status: routineStatus(addDays(date, terms.netDays)), receivedVia: rng.chance(0.5) ? 'mail' : 'email',
          lines: UTILITY_LINES[key]!.map(([desc, min, max]) => ({ poLineId: null, description: `${desc}, ${MONTHS[m]} 2026`, unit: 'month', qty: 1, priceCents: rng.int(min, max) })),
        });
      }
      continue;
    }

    const catalog = CATALOG[key] ?? CATALOG[vendor.category]!;
    const poCount = rng.int(2, 3);
    for (let p = 0; p < poCount; p++) {
      const orderDate = addDays('2026-01-05', rng.int(0, 58) + p * 3);
      const po: PurchaseOrder = { id: ids.next('PO-', 24001, 5), vendorId: vendor.id, orderDate, buyer: rng.pick(BUYERS), currency: vendor.currency, lines: [] };
      const products = rng.shuffle(catalog).slice(0, rng.int(1, Math.min(3, catalog.length)));
      products.forEach((prod, i) => {
        let price = rng.int(prod.minCents, prod.maxCents);
        if (prod.billedAs) price -= price % prod.billedAs.factor; // keeps the per-unit price in whole cents
        po.lines.push({ id: `${po.id}-${i + 1}`, poId: po.id, description: prod.description, unit: prod.unit, qty: rng.int(prod.minQty, prod.maxQty), priceCents: price });
      });
      pos.push(po);

      // Deliveries: one or two receipts per line, a few days after the order.
      let lastReceipt = orderDate;
      let complete = true;
      for (const line of po.lines) {
        const first = addDays(orderDate, rng.int(2, 6));
        const split = rng.chance(0.25) && line.qty > 10;
        const parts = split ? [Math.floor(line.qty / 2), line.qty - Math.floor(line.qty / 2)] : [line.qty];
        parts.forEach((qty, i) => {
          const date = addDays(first, i * rng.int(2, 5));
          if (date >= BUSINESS_DATE) {
            complete = false;
            return;
          }
          receipts.push({ id: ids.next('R-', 50001, 5), poLineId: line.id, qty, date });
          if (date > lastReceipt) lastReceipt = date;
        });
      }
      if (!complete) continue; // not invoiced yet

      let invoiceDate = addDays(lastReceipt, rng.int(0, 3));
      if (invoiceDate >= BUSINESS_DATE) continue;
      if (terms.discountDays > 0) {
        // Keep routine discount invoices out of the "expires before next run" window.
        const deadline = addDays(invoiceDate, terms.discountDays);
        if (deadline >= BUSINESS_DATE && deadline < NEXT_RUN_DATE) invoiceDate = addDays(NEXT_RUN_DATE, -terms.discountDays);
      }
      const lines: InvoiceLine[] = po.lines.map((l, i) => {
        const prod = products[i]!;
        if (prod.billedAs) {
          return { poLineId: l.id, description: l.description, unit: prod.billedAs.unit, qty: l.qty * prod.billedAs.factor, priceCents: l.priceCents / prod.billedAs.factor };
        }
        return { poLineId: l.id, description: l.description, unit: l.unit, qty: l.qty, priceCents: l.priceCents };
      });
      const dueDate = addDays(invoiceDate, terms.netDays);
      invoices.push({ id: '', vendorId: vendor.id, number: nextNumber(vendor), date: invoiceDate, dueDate, currency: vendor.currency, status: routineStatus(dueDate), receivedVia: rng.chance(0.6) ? 'erp' : 'email', lines });
    }
  }

  return { pos, receipts, invoices };
}

/** Paid invoices get one payment, on the last Monday run on or before the due date. */
export function payHistory(invoices: Invoice[], vendors: Map<string, Vendor>): Payment[] {
  const byId = new Map([...vendors.values()].map((v) => [v.id, v]));
  return invoices
    .filter((inv) => inv.status === 'paid')
    .map((inv) => {
      let date = runOnOrBefore(inv.dueDate);
      if (date < inv.date) date = addDays(runOnOrBefore(inv.date), 7);
      if (daysBetween(date, BUSINESS_DATE) <= 0) date = addDays(runOnOrBefore(BUSINESS_DATE), -7);
      return { invoice: inv, amountCents: invoiceTotalCents(inv), date, account: byId.get(inv.vendorId)!.remitAccount };
    });
}
