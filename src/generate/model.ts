// The clean model the generator builds first. Messiness is added only when files are written.

export type Category = 'growers' | 'packaging' | 'freight' | 'equipment_service' | 'utilities';

export interface Vendor {
  id: string;
  legalName: string;
  tradingNames: string[];
  category: Category;
  terms: string; // NET30, 2/10 NET30, ...
  remitAccount: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  domain: string;
  currency: string;
  status: 'active' | 'inactive';
}

export interface PoLine {
  id: string;
  poId: string;
  description: string;
  unit: string;
  qty: number;
  priceCents: number;
}

export interface PurchaseOrder {
  id: string;
  vendorId: string;
  orderDate: string;
  buyer: string;
  currency: string;
  lines: PoLine[];
}

export interface Receipt {
  id: string;
  poLineId: string;
  qty: number;
  date: string;
}

export interface InvoiceLine {
  poLineId: string | null;
  description: string;
  unit: string;
  qty: number;
  priceCents: number;
}

export type InvoiceStatus = 'open' | 'approved' | 'paid' | 'on_hold';

export interface Invoice {
  id: string; // assigned after all invoices exist, in date order
  vendorId: string;
  number: string; // as the vendor prints it
  date: string;
  dueDate: string;
  currency: string;
  status: InvoiceStatus;
  receivedVia: 'erp' | 'email' | 'mail';
  lines: InvoiceLine[];
  printedVendorName?: string; // force a specific name variant
  printedNumber?: string; // force a specific number format
}

export interface Payment {
  invoice: Invoice;
  amountCents: number;
  date: string;
  account: string;
}

export interface Email {
  id: string;
  slug: string;
  date: string; // ISO date
  time: string; // HH:MM
  fromName: string;
  fromAddress: string;
  replyTo?: string;
  subject: string;
  body: string;
}

export interface World {
  vendors: Vendor[];
  pos: PurchaseOrder[];
  receipts: Receipt[];
  invoices: Invoice[];
  payments: Payment[];
  emails: Email[];
}

export function invoiceTotalCents(inv: Invoice): number {
  return inv.lines.reduce((sum, l) => sum + l.qty * l.priceCents, 0);
}
