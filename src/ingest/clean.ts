import { isIsoDate } from '../lib/dates';

// Cleaning rules. Each one returns the clean value and records its decision in the log,
// so a reader can see exactly what changed between the raw files and facts.db.

export interface LogEntry {
  rule: string;
  record: string;
  before: string;
  after: string;
  reason: string;
}

export class CleaningLog {
  readonly entries: LogEntry[] = [];
  add(rule: string, record: string, before: string, after: string, reason: string): void {
    this.entries.push({ rule, record, before, after, reason });
  }
}

const ABBREVIATIONS: Record<string, string> = { pkg: 'packaging', frt: 'freight', svc: 'service', svcs: 'services' };
const LEGAL_SUFFIXES = new Set(['llc', 'ltd', 'inc', 'co', 'company', 'corp', 'srl']);

/** "HARLOW PKG", "Harlow Packaging Ltd" -> "harlow packaging". */
export function vendorNameKey(name: string): string {
  const words = name
    .toLowerCase()
    .replaceAll('&', ' and ')
    .replace(/[.,']/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ABBREVIATIONS[w] ?? w);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1)!)) words.pop();
  return words.join(' ');
}

export function matchVendor(log: CleaningLog, record: string, printed: string, keys: Map<string, string>, legalNames: Map<string, string>): string | null {
  const vendorId = keys.get(vendorNameKey(printed));
  if (!vendorId) {
    log.add('vendor_unmatched', record, printed, '', 'no vendor matches this name after normalization');
    return null;
  }
  if (printed !== legalNames.get(vendorId)) {
    log.add('vendor_name', record, printed, vendorId, `normalized name matches ${legalNames.get(vendorId)}`);
  }
  return vendorId;
}

/** "INV-00412", "inv 412", "412" -> "412". "cvd-55821" -> "CVD55821". */
export function invoiceNumberKey(printed: string): string {
  const compact = printed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const numeric = /^(?:INVOICE|INV)?0*(\d+)$/.exec(compact);
  return numeric ? numeric[1]! : compact;
}

export function cleanInvoiceNumber(log: CleaningLog, record: string, printed: string): string {
  const key = invoiceNumberKey(printed);
  if (key !== printed.replaceAll('-', '')) log.add('invoice_number', record, printed, key, 'compared on a normalized key');
  return key;
}

/** "1234.50", "$1,234.50" -> 123450. Returns null when the text is not an amount. */
export function cleanMoney(log: CleaningLog, record: string, text: string): number | null {
  const stripped = text.trim().replace(/[$,]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(stripped)) return null;
  const cents = Math.round(Number(stripped) * 100);
  if (stripped !== text.trim()) log.add('money_format', record, text, String(cents), 'removed currency symbol and separators');
  return cents;
}

/** ISO dates pass through; US "MM/DD/YYYY" is converted. */
export function cleanDate(log: CleaningLog, record: string, text: string): string | null {
  const t = text.trim();
  if (isIsoDate(t)) return t;
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (us) {
    const iso = `${us[3]}-${us[1]}-${us[2]}`;
    if (isIsoDate(iso)) {
      log.add('date_format', record, t, iso, 'US date converted to ISO');
      return iso;
    }
  }
  return null;
}

export function cleanCurrency(log: CleaningLog, record: string, text: string, vendorCurrency: string): string {
  const t = text.trim();
  if (t === '') {
    log.add('currency_default', record, '', vendorCurrency, "blank currency; used the vendor's currency");
    return vendorCurrency;
  }
  if (t !== t.toUpperCase()) log.add('currency_case', record, t, t.toUpperCase(), 'currency codes are upper case');
  return t.toUpperCase();
}

const UNIT_SYNONYMS: Record<string, string> = { ea: 'each', each: 'each', cs: 'case', case: 'case', rl: 'roll', roll: 'roll' };

export function cleanUnit(log: CleaningLog, record: string, text: string): string {
  const key = text.trim().toLowerCase().replace(/\.$/, '');
  const unit = UNIT_SYNONYMS[key] ?? key;
  if (unit !== text) log.add('unit_name', record, text, unit, 'unit spelling normalized');
  return unit;
}

export function cleanTerms(log: CleaningLog, record: string, text: string): string {
  const t = text.trim().toUpperCase().replace(/NET\s+/, 'NET');
  if (t !== text) log.add('payment_terms', record, text, t, 'terms normalized');
  return t;
}
