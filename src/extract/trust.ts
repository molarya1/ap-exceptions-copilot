import type { ParsedEmail } from '../ingest/email';
import type { VerifiedExtraction } from './schema';

// Trust flags are set by code, never by the model.

export interface TrustFlag {
  flag: 'lookalike_domain' | 'reply_to_mismatch' | 'embedded_instructions';
  detail: string;
}

export interface KnownDomain {
  domain: string;
  vendorId: string;
  name: string;
}

export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** A domain close to, but not equal to, a known vendor domain. */
export function lookalikeOf(domain: string, known: KnownDomain[]): KnownDomain | null {
  if (known.some((k) => k.domain === domain)) return null;
  return known.find((k) => editDistance(domain, k.domain) <= 2) ?? null;
}

export function trustFlags(email: ParsedEmail, known: KnownDomain[], extraction: VerifiedExtraction | undefined): TrustFlag[] {
  const flags: TrustFlag[] = [];
  const twin = lookalikeOf(email.fromDomain, known);
  if (twin) {
    flags.push({ flag: 'lookalike_domain', detail: `${email.fromDomain} looks like ${twin.domain} (${twin.name}, ${twin.vendorId})` });
  }
  if (email.replyTo && email.replyTo !== email.fromAddress) {
    flags.push({ flag: 'reply_to_mismatch', detail: `replies go to ${email.replyTo}, not ${email.fromAddress}` });
  }
  const quotes = extraction?.instructionQuotes ?? [];
  if (quotes.length > 0) {
    flags.push({ flag: 'embedded_instructions', detail: `text addressed to automated systems: "${quotes[0]!.slice(0, 160)}"` });
  }
  return flags;
}
