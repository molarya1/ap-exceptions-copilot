import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BUSINESS_DATE, DUPLICATE_WINDOW_DAYS, NEXT_RUN_DATE, PATHS } from '../config';
import { daysBetween } from '../lib/dates';
import { Rng } from '../lib/prng';
import type { World } from './model';
import { invoiceTotalCents } from './model';
import { renderFiles } from './render';
import { buildRoutine, Ids, payHistory } from './routine';
import { plantScenarios } from './scenarios';
import { buildVendors } from './vendors';

// `npm run generate`: writes data/ from a fixed seed. Same seed, same bytes.

export const SEED = 20260316;

export function generate(seed = SEED): { files: Map<string, string>; scenarios: unknown } {
  const rng = new Rng(seed);
  const ids = new Ids();
  const vendors = buildVendors(rng);
  const routine = buildRoutine(rng, vendors, ids);
  assertNoAccidentalDuplicates(routine.invoices);

  const world: World = { vendors: [...vendors.values()], ...routine, emails: [], payments: [] };
  const { truths, noise } = plantScenarios({ rng, ids, vendors, world });

  // Ids follow document order: invoices by date, emails by arrival.
  world.invoices.sort((a, b) => a.date.localeCompare(b.date) || a.vendorId.localeCompare(b.vendorId) || b.receivedVia.localeCompare(a.receivedVia));
  world.invoices.forEach((inv, i) => (inv.id = `AP-26-${String(i + 1).padStart(4, '0')}`));
  world.emails.sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  world.emails.forEach((e, i) => (e.id = `m${String(i + 1).padStart(2, '0')}`));
  world.payments = payHistory(world.invoices, vendors).sort((a, b) => a.date.localeCompare(b.date) || a.invoice.id.localeCompare(b.invoice.id));

  const scenarios = {
    note: 'Ground truth for evals only. The app and the agent never read this file.',
    seed,
    business_date: BUSINESS_DATE,
    next_run_date: NEXT_RUN_DATE,
    scenarios: truths.map((t) => ({
      id: t.id,
      kind: t.kind,
      summary: t.summary,
      vendor_id: t.vendorId,
      invoice_ids: t.invoices.map((i) => i.id),
      email_ids: t.emails.map((e) => e.id),
      facts: t.facts,
    })),
    noise_email_ids: noise.map((e) => e.id),
  };

  const files = renderFiles(rng, world);
  files.set('scenarios.json', JSON.stringify(scenarios, null, 2) + '\n');
  return { files, scenarios };
}

function assertNoAccidentalDuplicates(invoices: World['invoices']): void {
  for (const a of invoices) {
    for (const b of invoices) {
      if (a === b || a.vendorId !== b.vendorId) continue;
      if (invoiceTotalCents(a) === invoiceTotalCents(b) && Math.abs(daysBetween(a.date, b.date)) <= DUPLICATE_WINDOW_DAYS) {
        throw new Error(`routine data has an accidental duplicate for ${a.vendorId}; change the seed`);
      }
    }
  }
}

function main(): void {
  const { files } = generate();
  rmSync(PATHS.data, { recursive: true, force: true });
  for (const [name, content] of files) {
    const path = join(PATHS.data, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  console.log(`wrote ${files.size} files to ${PATHS.data}/`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
