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

import { detectIssues } from '../src/detect/index';
import type { Issue } from '../src/detect/types';
import { fixtureExtractions } from './fixtures/extractions';

let world: Promise<{ facts: Facts; issues: Issue[] }> | undefined;
/** facts.db with fixture extractions, plus the detected issues. Built once per file. */
export function sharedWorld(): Promise<{ facts: Facts; issues: Issue[] }> {
  world ??= buildFacts('data', fixtureExtractions()).then((f) => ({ facts: f, issues: detectIssues(f.db) }));
  return world;
}

export function issueFor(issues: Issue[], scenarioId: string): Issue {
  const s = scenario(scenarioId);
  const hit = issues.find((i) => i.type === s.kind && s.invoice_ids.every((id) => i.invoice_ids.includes(id)) && s.email_ids.every((e) => i.email_ids.includes(e) || !i.type.match(/bank|suspicious/)));
  if (!hit) throw new Error(`no issue for scenario ${scenarioId}`);
  return hit;
}

export { duplicateCopies } from '../src/detect/index';

export function vendorRow(f: Facts, vendorId: string) {
  return f.db.get<{ remit_account: string; contact_name: string; contact_phone: string; contact_email: string }>(
    'SELECT remit_account, contact_name, contact_phone, contact_email FROM vendors WHERE vendor_id = ?',
    [vendorId],
  )!;
}
