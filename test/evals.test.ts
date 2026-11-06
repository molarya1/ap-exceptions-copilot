import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordCases, runEvals, type EvalOptions } from '../evals/harness';
import { renderReport } from '../evals/report';
import { fixtureExtractionTransport, scriptedTransport } from './fixtures/transports';

// The eval harness end to end, with the scripted test agent standing in for the model:
// record every case, then grade them from the recordings.

test('eval harness records, replays and grades every case', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apx-eval-'));
  const o: EvalOptions = { dataDir: 'data', cachePath: join(dir, 'extractions.json'), recordedDir: join(dir, 'recorded') };
  const recorded = await recordCases(o, { agent: scriptedTransport(), extraction: fixtureExtractionTransport() }, 'medium');
  assert.deepEqual(recorded.filter((r) => r.status === 'skipped').map((r) => r.id), ['noise', 'overlay_late_receipt']);

  const report = await runEvals(o);
  assert.deepEqual(report.extraction_missing, []);
  assert.deepEqual((await runEvals(o)).results.map((x) => x.pass), report.results.map((x) => x.pass), 'replay is repeatable');

  // The scripted agent ignores the buyer's email and disputes the price, which the overlay case must catch.
  assert.deepEqual(report.results.filter((x) => !x.pass).map((x) => x.id), ['overlay_buyer_confirms_price']);
  const buyer = report.results.find((x) => x.id === 'overlay_buyer_confirms_price')!;
  assert.match(buyer.decision!.reasons.join(' '), /forbidden action short_pay/);

  // Guardrails ran on real proposals and all held.
  for (const x of report.results) if (x.guardrails) assert.deepEqual(x.guardrails.reasons, [], x.id);
  const md = renderReport(report);
  assert.match(md, /10 of 11 cases pass/);
  assert.match(md, /`claude-sonnet-5-5` via messages-api/);
});

test('replay without recordings fails each decision case with a clear message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apx-eval-'));
  const r = await runEvals({ dataDir: 'data', cachePath: join(dir, 'none.json'), recordedDir: join(dir, 'recorded') });
  const dup = r.results.find((x) => x.id === 'duplicate_invoice')!;
  assert.equal(dup.pass, false);
  assert.match(dup.decision!.reasons[0]!, /no recording .*npm run eval -- --case duplicate_invoice/);
  assert.equal(r.results.find((x) => x.id === 'overlay_late_receipt')!.pass, true);
});
