import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { memoryAudit } from '../src/agent/audit';
import { loadRecording, replayRun } from '../src/agent/replay';
import { App } from '../src/app';
import { testApp } from './fixtures/test-app';
import { scenario } from './helpers';

test('every recorded run replays to a valid plan with current code', async () => {
  const app = await testApp();
  for (const issue of app.issues) {
    const run = app.store.latestRun(issue.issue_id)!;
    assert.equal(run.status, 'planned', `${issue.issue_id}: ${run.failure}`);
    assert.equal(run.mode, 'replay');
  }
});

test('restarting replays again but stores nothing new when nothing changed', async () => {
  const app = await testApp();
  const before = app.store.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs')!.n;
  const again = await App.boot(app.opts);
  assert.equal(again.store.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs')!.n, before);
});

test("a recorded plan that today's checks reject shows as failed, not valid", async () => {
  const app = await testApp();
  const issue = app.issues.find((i) => i.type === 'discount_expiring')!;
  const path = join(app.opts.recordedDir, `${issue.issue_id}.json`);
  // Simulate a recording whose plan pays the undiscounted total while claiming the discount.
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  const submit = rec.tool_calls.findLast((c: { name: string }) => c.name === 'submit_plan');
  submit.input.actions[0].amount_cents += 100;
  writeFileSync(path, JSON.stringify(rec));

  const result = await replayRun(loadRecording(app.opts.recordedDir, issue.issue_id)!, { db: app.facts.db, issue, duplicateInvoices: app.duplicateInvoices(), audit: memoryAudit() });
  assert.equal(result.status, 'failed');
  assert.match(result.failure!, /current checks do not accept the recorded run/);
  assert.ok(result.tool_calls.some((c) => c.name === 'submit_plan' && /differs from discount_value/.test(c.error ?? '')));
});

test('replay re-runs calculators on current data: changed facts change the outcome', async () => {
  // The invoice gets a partial payment, so the recorded discount amount no longer matches.
  const inv = scenario('discount_juniper').invoice_ids[0];
  const app = await testApp();
  const changed = await App.boot({ ...app.opts, workPath: null, overlaySql: `INSERT INTO payments VALUES ('PAY-X', '${inv}', 100000, '2026-03-13', 'x', 'overlay')` });
  const run = changed.store.latestRun(`disc-${inv}`)!;
  assert.equal(run.status, 'failed');
});
