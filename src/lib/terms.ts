// Payment terms such as "NET30" or "2/10 NET30" (2% off if paid within 10 days, else due in 30).
export interface Terms {
  discountPct: number;
  discountDays: number;
  netDays: number;
}

export function parseTerms(terms: string): Terms | null {
  const m = /^(?:(\d+(?:\.\d+)?)\/(\d+)\s*)?NET\s*(\d+)$/.exec(terms.trim().toUpperCase());
  if (!m) return null;
  return {
    discountPct: m[1] ? Number(m[1]) / 100 : 0,
    discountDays: m[2] ? Number(m[2]) : 0,
    netDays: Number(m[3]),
  };
}
