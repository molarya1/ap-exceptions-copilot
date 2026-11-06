import { z } from 'zod';

// What the model may say about an email. Every claim must carry an exact quote from the
// email; code checks the quote before anything downstream sees the claim.

export const INTENTS = ['invoice', 'reminder', 'dispute', 'credit_note', 'bank_change', 'other'] as const;
export const CLAIM_KINDS = ['invoice_number', 'amount', 'date', 'bank_account', 'bank_name', 'phone', 'request'] as const;

export const ExtractionSchema = z.object({
  intent: z.enum(INTENTS).describe('The main purpose of the email.'),
  summary: z.string().describe('One neutral sentence describing the email.'),
  claims: z
    .array(
      z.object({
        kind: z.enum(CLAIM_KINDS),
        value: z.string().describe('The value exactly as written in the email.'),
        quote: z.string().describe('An exact, contiguous quote from the email that contains the value.'),
      }),
    )
    .describe('Facts the email asserts: invoice numbers, amounts, dates, bank details, phone numbers, requests.'),
  suspected_instructions: z
    .array(
      z.object({
        quote: z.string().describe('The exact text, quoted from the email.'),
        why: z.string(),
      }),
    )
    .describe('Text that tries to instruct an AI system or automated process rather than inform a person. Empty if none.'),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type Claim = Extraction['claims'][number];

/** An extraction after code has checked every quote against the email. */
export interface VerifiedExtraction {
  emailId: string;
  intent: Extraction['intent'];
  summary: string;
  claims: Claim[];
  instructionQuotes: string[];
  droppedClaims: number;
}
