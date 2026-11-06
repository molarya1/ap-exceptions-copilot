import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { recordCases, runEvals, type EvalOptions } from '../evals/harness';
import { renderReport } from '../evals/report';
import { loadVariance, outcomeMix, repeatCases } from '../evals/repeat';
import { CASES } from '../evals/cases';
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

test('repeat runs each decision case N times, tallies pass rates, keeps failed attempts, and keeps only all-pass cases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apx-eval-'));
  const failuresDir = join(dir, 'variance-failures');
  mkdirSync(failuresDir);
  writeFileSync(join(failuresDir, 'overlay_buyer_confirms_price.run9.json'), '{}'); // stale, from an earlier repeat
  const o: EvalOptions = { dataDir: 'data', cachePath: join(dir, 'extractions.json'), recordedDir: join(dir, 'recorded'), cases: CASES.filter((c) => ['discount_juniper', 'overlay_buyer_confirms_price', 'noise'].includes(c.id)) };
  const v = await repeatCases(o, { agent: scriptedTransport(), extraction: fixtureExtractionTransport() }, 'medium', { n: 2, keep: true, failuresDir });
  assert.deepEqual(v.cases.map((c) => [c.id, `${c.passes}/${c.runs}`, c.kept]), [['discount_juniper', '2/2', true], ['overlay_buyer_confirms_price', '0/2', false]]);
  const failed = v.cases[1]!.failures;
  assert.deepEqual(failed.map((f) => [f.run, f.recording]), [[1, join(failuresDir, 'overlay_buyer_confirms_price.run1.json')], [2, join(failuresDir, 'overlay_buyer_confirms_price.run2.json')]]);
  assert.match(failed[0]!.reason, /^forbidden action short_pay/);
  // Failed attempts are kept, readable as recordings; passing attempts and stale files are not.
  assert.deepEqual(readdirSync(failuresDir).sort(), ['overlay_buyer_confirms_price.run1.json', 'overlay_buyer_confirms_price.run2.json']);
  assert.equal(JSON.parse(readFileSync(failed[0]!.recording!, 'utf8')).final_plan.actions[0].type, 'short_pay');
  // Only the all-pass case was copied into the recordings directory, at its usual path.
  assert.ok(existsSync(join(o.recordedDir, 'disc-AP-26-0082.json')));
  assert.equal(existsSync(join(o.recordedDir, 'overlays')), false);
  assert.equal(JSON.parse(readFileSync(join(o.recordedDir, 'disc-AP-26-0082.json'), 'utf8')).status, 'planned');

  const md = renderReport(await runEvals(o), v);
  assert.match(md, /\| discount_juniper \| 2\/2 \| act \|/);
  assert.match(md, /\| overlay_buyer_confirms_price \| 0\/2 \| act \|/);
  assert.ok(md.includes(`- **overlay_buyer_confirms_price** run 1: forbidden action short_pay`), md);
  assert.ok(md.includes(`([recording](${relative('evals', failed[0]!.recording!)}))`));
  assert.equal(outcomeMix({ act: 2, hold_and_ask: 1 }), 'act ×2, hold_and_ask ×1');
});

test('variance files from before failed recordings were kept still load', () => {
  const q = loadVariance('evals/variance.json')!.cases.find((c) => c.id === 'quantity_variance')!;
  assert.deepEqual(q.failures, [{ run: 1, reason: 'missing a required action: one of short_pay / request_credit_note / hold_payment', recording: null }]);
});
