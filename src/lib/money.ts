// Money is integer cents everywhere in code and storage. Strings appear only at the edges.

export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function formatCents(cents: number, currency = 'USD'): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}${currency === 'USD' ? '$' : `${currency} `}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** Plain decimal with two places, as an ERP export would print it. */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
