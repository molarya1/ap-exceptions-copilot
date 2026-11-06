import { buildFacts, type Facts } from '../src/ingest/build';
import type { VerifiedExtraction } from '../src/extract/schema';
import { readFileSync } from 'node:fs';

// Shared fixtures. Ground truth comes from data/scenarios.json, which only tests and evals read.

export interface Scenario {
  id: string;
  kind: string;
  vendor_id: string;
  invoice_ids: string[];
  email_ids: string[];
  facts: Record<string, string | number>;
}

export const truth = JSON.parse(readFileSync('data/scenarios.json', 'utf8')) as { scenarios: Scenario[]; noise_email_ids: string[] };

export function scenario(id: string): Scenario {
  const s = truth.scenarios.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
}

let shared: Promise<Facts> | undefined;
/** facts.db built once per test file, with no email extractions. */
export function sharedFacts(): Promise<Facts> {
  shared ??= buildFacts('data', new Map());
  return shared;
}

export function facts(extractions = new Map<string, VerifiedExtraction>(), overlaySql?: string): Promise<Facts> {
  return buildFacts('data', extractions, overlaySql ? { overlaySql } : {});
}
