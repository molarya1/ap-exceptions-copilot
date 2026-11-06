import type { ParsedEmail } from '../ingest/email';
import type { Extraction, VerifiedExtraction } from './schema';

// The model's quotes are checked here, in code. A claim whose quote is not in the email,
// or whose value is not inside its own quote, is dropped.

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export function quoteAppears(email: Pick<ParsedEmail, 'subject' | 'body'>, quote: string): boolean {
  const q = squash(quote);
  return q.length >= 3 && (squash(email.body).includes(q) || squash(email.subject).includes(q));
}

export function verifyExtraction(email: ParsedEmail, raw: Extraction): VerifiedExtraction {
  const claims = raw.claims.filter((c) => quoteAppears(email, c.quote) && squash(c.quote).includes(squash(c.value)));
  return {
    emailId: email.emailId,
    intent: raw.intent,
    summary: raw.summary,
    claims,
    instructionQuotes: raw.suspected_instructions.map((s) => s.quote).filter((q) => quoteAppears(email, q)),
    droppedClaims: raw.claims.length - claims.length,
  };
}

/** The new bank account an email asks for, if any. Only an evidenced claim counts. */
export function claimedBankAccount(x: VerifiedExtraction | undefined): { account: string; bank: string | null } | null {
  if (!x || x.intent !== 'bank_change') return null;
  const account = x.claims.find((c) => c.kind === 'bank_account')?.value;
  if (!account) return null;
  return { account, bank: x.claims.find((c) => c.kind === 'bank_name')?.value ?? null };
}
