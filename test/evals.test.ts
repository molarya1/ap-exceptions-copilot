import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runEvals, type EvalOptions } from '../evals/harness';
import { renderReport } from '../evals/report';
import { rawFixtureExtractions } from './fixtures/extractions';
import { scriptedAgent } from './fixtures/scripted-agent';

// The eval harness end to end, with the scripted test agent standing in for the model:
// record in "live" mode, then replay the recordings and get the same grades.

test('eval harness records, replays and grades every case', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apx-eval-'));
  const raw = rawFixtureExtractions();
  const base: EvalOptions = { mode: 'live', dataDir: 'data', cachePath: join(dir, 'extractions.json'), recordedDir: join(dir, 'recorded'), model: 'scripted', effort: 'medium' };
  const live = await runEvals({ ...base, api: scriptedAgent(), extractor: { model: 'fixture', extract: async (e) => raw.get(e.emailId)! } });
  const replay = await runEvals({ ...base, mode: 'replay' });

  const grades = (r: typeof live) => Object.fromEntries(r.results.map((x) => [x.id, x.pass]));
  assert.deepEqual(grades(replay), grades(live));
  assert.deepEqual(replay.extraction_missing, []);

  // The scripted agent ignores the buyer's email and disputes the price, which the overlay case must catch.
  const failing = replay.results.filter((x) => !x.pass).map((x) => x.id);
  assert.deepEqual(failing, ['overlay_buyer_confirms_price']);
  const buyer = replay.results.find((x) => x.id === 'overlay_buyer_confirms_price')!;
  assert.match(buyer.decision!.reasons.join(' '), /forbidden action short_pay/);

  // Guardrails ran on real proposals and all held.
  for (const x of replay.results) if (x.guardrails) assert.deepEqual(x.guardrails.reasons, [], x.id);
  assert.match(renderReport(replay), /10 of 11 cases pass/);
});

test('replay without recordings fails each decision case with a clear message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apx-eval-'));
  const r = await runEvals({ mode: 'replay', dataDir: 'data', cachePath: join(dir, 'none.json'), recordedDir: join(dir, 'recorded'), model: 'x', effort: 'medium' });
  const dup = r.results.find((x) => x.id === 'duplicate_invoice')!;
  assert.equal(dup.pass, false);
  assert.match(dup.decision!.reasons[0]!, /no recording .*npm run eval/);
  assert.equal(r.results.find((x) => x.id === 'overlay_late_receipt')!.pass, true);
});
