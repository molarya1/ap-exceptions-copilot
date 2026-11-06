import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Action } from '../src/actions/schema';
import type { RunResult } from '../src/agent/loop';
import { emptyUsage } from '../src/llm/cost';
import { detectIssues } from '../src/detect/index';
import { approveAction, rejectAction, type ApprovalDeps } from '../src/work/approvals';
import { mintCapability } from '../src/work/capability';
import { WorkStore } from '../src/work/store';
import { fixtureExtractions } from './fixtures/extractions';
import { duplicateCopies, facts, issueFor, scenario, sharedWorld, vendorRow } from './helpers';

function result(actions: Action[]): RunResult {
  return {
    status: 'planned', failure: null, tool_calls: [], usage: emptyUsage(), cost_usd: 0, cost_estimated: false, duration_ms: 1, model: 'test', transport: 'messages-api',
    plan: { summary: 's', options: [{ id: 'a', description: 'a', consequences: 'c', chosen: true }, { id: 'b', description: 'nothing', consequences: 'c', chosen: false }], outcome: 'act', rationale: 'r', actions, open_questions: [], evidence_ids: ['AP-26-0001'] },
  };
}

async function setup(path: string | null = null) {
  const { facts: f, issues } = await sharedWorld();
  const store = await WorkStore.open(path);
  store.syncIssues(issues);
  const s = scenario('discount_juniper');
  const inv = s.invoice_ids[0]!;
  const pay: Action = { type: 'schedule_payment', invoice_id: inv, amount_cents: 1_215_200, currency: 'USD', take_discount: true, pay_to_account: vendorRow(f, s.vendor_id).remit_account };
  const { runId } = store.saveRun(issueFor(issues, 'discount_juniper').issue_id, 'replay', result([pay]));
  const action = store.actions({ planId: runId })[0]!;
  const deps: ApprovalDeps = { store, facts: f.db, duplicateCopies: () => duplicateCopies(issues) };
  return { store, deps, action, issues, inv };
}

const human = () => mintCapability('session-test');

test('approve-and-send works once and writes one outbox row', async () => {
  const { deps, action, store } = await setup();
  const first = approveAction(human(), deps, action.action_id, action.payload_hash);
  assert.equal(first.ok, true);
  const outbox = store.db.all<{ outbox_id: number; kind: string; document_json: string }>('SELECT outbox_id, kind, document_json FROM outbox');
  assert.equal(outbox.length, 1);
  assert.deepEqual(first, { ok: true, outboxId: outbox[0]!.outbox_id });
  assert.equal(outbox[0]!.kind, 'payment_run_entry');
  assert.match(outbox[0]!.document_json, /\$12,152\.00/);

  const again = approveAction(human(), deps, action.action_id, action.payload_hash);
  assert.deepEqual(again, { ok: false, refused: 'action is already approved' });
  assert.equal(store.db.all('SELECT 1 FROM outbox').length, 1);
});

test('a forged capability is refused', async () => {
  const { deps, action, store } = await setup();
  const forged = Object.freeze({ sessionId: 'session-test' });
  const d = approveAction(forged, deps, action.action_id, action.payload_hash);
  assert.equal(d.ok, false);
  assert.match((d as { refused: string }).refused, /no human capability/);
  assert.equal(store.action(action.action_id)!.status, 'proposed');
});

test('a payload hash other than the stored one is refused', async () => {
  const { deps, action } = await setup();
  const d = approveAction(human(), deps, action.action_id, 'f'.repeat(64));
  assert.equal(d.ok, false);
  assert.match((d as { refused: string }).refused, /payload hash does not match/);
});

test('a tampered stored payload is refused', async () => {
  const { deps, action, store } = await setup();
  store.tx(() => store.db.run("UPDATE actions SET payload_json = replace(payload_json, '1215200', '1240000') WHERE action_id = ?", [action.action_id]));
  const d = approveAction(human(), deps, action.action_id, action.payload_hash);
  assert.match((d as { refused: string }).refused, /stored payload does not match its hash/);
});

test('a stale action is refused when current data no longer supports it', async () => {
  const { store, action, inv } = await setup();
  const changed = await facts(fixtureExtractions(), `INSERT INTO payments VALUES ('PAY-X', '${inv}', 1215200, '2026-03-15', 'x', 'overlay'); UPDATE invoices SET status = 'paid' WHERE invoice_id = '${inv}';`);
  const issues = detectIssues(changed.db);
  // The discount issue disappears once the invoice is paid; even if it were still active, the re-check refuses.
  store.syncIssues(issues);
  const d1 = approveAction(human(), { store, facts: changed.db, duplicateCopies: () => duplicateCopies(issues) }, action.action_id, action.payload_hash);
  assert.match((d1 as { refused: string }).refused, /no longer detected/);

  store.tx(() => store.db.run('UPDATE issues SET active = 1'));
  const d2 = approveAction(human(), { store, facts: changed.db, duplicateCopies: () => duplicateCopies(issues) }, action.action_id, action.payload_hash);
  assert.equal(d2.ok, false);
  assert.match((d2 as { refused: string }).refused, /preconditions no longer hold/);
  assert.ok((d2 as { problems: string[] }).problems.some((p) => /status is paid/.test(p)));
});

test('two actions committing the same invoice: the second is refused, with no outbox row', async () => {
  const { store, deps, action, issues, inv } = await setup();
  const otherIssue = issueFor(issues, 'duplicate_invoice').issue_id;
  const { runId } = store.saveRun(otherIssue, 'replay', result([{ type: 'hold_payment', invoice_id: inv, reason: 'overlap test' }]));
  const hold = store.actions({ planId: runId })[0]!;

  assert.equal(approveAction(human(), deps, hold.action_id, hold.payload_hash).ok, true);
  const d = approveAction(human(), deps, action.action_id, action.payload_hash);
  assert.equal(d.ok, false);
  assert.match((d as { refused: string }).refused, /already committed by approved action/);
  assert.equal(store.action(action.action_id)!.status, 'proposed');
  assert.equal(store.db.all('SELECT 1 FROM outbox').length, 1);
  assert.equal(store.db.all("SELECT 1 FROM approvals WHERE action_id = ?", [action.action_id]).length, 0);
});

test('a rejected action cannot be approved later', async () => {
  const { deps, action } = await setup();
  assert.equal(rejectAction(human(), deps, action.action_id, action.payload_hash, 'not now').ok, true);
  const d = approveAction(human(), deps, action.action_id, action.payload_hash);
  assert.match((d as { refused: string }).refused, /already rejected/);
});

test('refusals are written to the activity log', async () => {
  const { deps, action, store } = await setup();
  approveAction({}, deps, action.action_id, action.payload_hash);
  const row = store.db.get<{ event: string }>("SELECT event FROM activity WHERE event = 'approval_refused'");
  assert.ok(row);
});

test('work.db persists approvals across restarts; an identical re-run changes nothing', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'apx-')), 'work.db');
  const { deps, action, issues } = await setup(path);
  assert.equal(approveAction(human(), deps, action.action_id, action.payload_hash).ok, true);

  const reopened = await WorkStore.open(path);
  assert.equal(reopened.action(action.action_id)!.status, 'approved');
  const same = reopened.saveRun(issueFor(issues, 'discount_juniper').issue_id, 'replay', result([JSON.parse(action.payload_json)]));
  assert.equal(same.changed, false);
});

test('a changed re-run supersedes pending actions of the old plan', async () => {
  const { store, action, issues, inv } = await setup();
  const { changed } = store.saveRun(issueFor(issues, 'discount_juniper').issue_id, 'replay', result([{ type: 'hold_payment', invoice_id: inv, reason: 'changed mind' }]));
  assert.equal(changed, true);
  assert.equal(store.action(action.action_id)!.status, 'superseded');
});
