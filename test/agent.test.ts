import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryAudit } from '../src/agent/audit';
import { investigate, type RunDeps } from '../src/agent/loop';
import { runQuery, readEmail, ToolError } from '../src/agent/tools';
import { lastToolResults, scripted, type Turn } from './fixtures/fake-api';
import { duplicateInvoices, issueFor, scenario, sharedWorld, vendorRow } from './helpers';

async function deps(scenarioId: string, turns: Turn[], limits?: RunDeps['limits']) {
  const { facts, issues } = await sharedWorld();
  const api = scripted(turns);
  const audit = memoryAudit();
  const d: RunDeps = { api, db: facts.db, issue: issueFor(issues, scenarioId), duplicateInvoices: duplicateInvoices(issues), model: 'claude-sonnet-5-5', effort: 'medium', audit, ...(limits ? { limits } : {}) };
  return { d, api, audit, facts };
}

const options = [
  { id: 'pay', description: 'Pay now with the discount', consequences: 'saves the discount', chosen: true },
  { id: 'wait', description: 'Do nothing; pay at net terms', consequences: 'loses the discount', chosen: false },
];

test('a run investigates with tools and ends with an accepted plan', async () => {
  const s = scenario('discount_juniper');
  const inv = s.invoice_ids[0]!;
  const acct = vendorRow((await sharedWorld()).facts, s.vendor_id).remit_account;
  const { d, api, audit } = await deps('discount_juniper', [
    () => [{ text: 'Checking the discount.' }, { tool: 'discount_value', input: { invoice_id: inv } }],
    (params) => {
      const result = JSON.parse(String(lastToolResults(params)[0]!.content));
      return [{ tool: 'submit_plan', input: { summary: 's', options, outcome: 'act', rationale: 'r', open_questions: [], evidence_ids: [inv], actions: [{ type: 'schedule_payment', invoice_id: inv, amount_cents: result.pay_with_discount_cents, currency: 'USD', take_discount: true, pay_to_account: acct }] } }];
    },
  ]);
  const run = await investigate(d);
  assert.equal(run.status, 'planned', run.failure ?? '');
  assert.equal(run.plan!.actions[0]!.type, 'schedule_payment');
  assert.deepEqual(run.tool_calls.map((c) => c.name), ['discount_value', 'submit_plan']);
  assert.equal(run.responses.length, 2);
  assert.equal(run.usage.input_tokens, 2000);
  assert.ok(run.cost_usd !== null && run.cost_usd > 0);
  assert.ok(audit.events.some((e) => e.kind === 'plan_accepted'));

  // System prompt and tools carry cache breakpoints; effort is passed through.
  const req = api.requests[0]!;
  assert.deepEqual((req.system as { cache_control?: unknown }[])[0]!.cache_control, { type: 'ephemeral' });
  assert.deepEqual(req.tools!.at(-1)!.cache_control, { type: 'ephemeral' });
  assert.equal(req.output_config?.effort, 'medium');
});

test('a rejected plan goes back to the model with fixable problems', async () => {
  const s = scenario('discount_juniper');
  const inv = s.invoice_ids[0]!;
  const acct = vendorRow((await sharedWorld()).facts, s.vendor_id).remit_account;
  const submit = (amount: number) => ({ tool: 'submit_plan', input: { summary: 's', options, outcome: 'act', rationale: 'r', open_questions: [], evidence_ids: [inv], actions: [{ type: 'schedule_payment', invoice_id: inv, amount_cents: amount, currency: 'USD', take_discount: true, pay_to_account: acct }] } });
  let feedback = '';
  const { d } = await deps('discount_juniper', [
    () => [{ tool: 'discount_value', input: { invoice_id: inv } }],
    () => [submit(1_200_000)],
    (params) => {
      const r = lastToolResults(params)[0]!;
      feedback = String(r.content);
      assert.equal(r.is_error, true);
      return [submit(1_215_200)];
    },
  ]);
  const run = await investigate(d);
  assert.equal(run.status, 'planned');
  assert.match(feedback, /differs from discount_value.pay_with_discount_cents 1215200/);
});

test('repeated rejections end the run as failed', async () => {
  const { d } = await deps('discount_juniper', [() => [{ tool: 'submit_plan', input: { summary: 's', options, outcome: 'act', rationale: 'r', open_questions: [], evidence_ids: [], actions: [] } }]]);
  const run = await investigate(d);
  assert.equal(run.status, 'failed');
  assert.match(run.failure!, /rejected 4 times/);
});

test('the tool budget is enforced, then the model may still submit', async () => {
  let calls = 0;
  const { d } = await deps('discount_juniper', [
    (params) => {
      const refused = lastToolResults(params).some((r) => String(r.content).includes('budget'));
      if (refused) return [{ tool: 'submit_plan', input: { summary: 's', options: [{ ...options[0]!, chosen: false }, { ...options[1]!, chosen: true }], outcome: 'no_action', rationale: 'r', open_questions: [], evidence_ids: [scenario('discount_juniper').invoice_ids[0]], actions: [] } }];
      calls++;
      return [{ tool: 'query', input: { sql: 'SELECT COUNT(*) FROM invoices' } }];
    },
  ], { maxToolCalls: 3 });
  const run = await investigate(d);
  assert.equal(run.status, 'planned');
  assert.equal(run.tool_calls.filter((c) => c.name === 'query' && !c.error).length, 3);
  assert.equal(run.tool_calls.filter((c) => c.error === 'tool budget exhausted').length, 1);
  assert.equal(calls, 4);
});

test('a model that never submits fails after one nudge', async () => {
  const { d } = await deps('discount_juniper', [() => [{ text: 'I think we should pay it.' }]]);
  const run = await investigate(d);
  assert.equal(run.status, 'failed');
  assert.match(run.failure!, /without submitting/);
  assert.equal(run.responses.length, 2);
});

test('the wall-clock deadline stops a run', async () => {
  const { d } = await deps('discount_juniper', [() => [{ tool: 'query', input: { sql: 'SELECT 1' } }]], { deadlineMs: 0 });
  const run = await investigate(d);
  assert.equal(run.status, 'failed');
  assert.match(run.failure!, /deadline/);
});

test('invalid tool input comes back as an error the model can fix', async () => {
  let seen = '';
  const { d } = await deps('discount_juniper', [
    () => [{ tool: 'match_check', input: { invoice: 'x' } }],
    (params) => {
      seen = String(lastToolResults(params)[0]!.content);
      return [{ text: 'done' }];
    },
  ]);
  await investigate(d);
  assert.match(seen, /Invalid input/);
});

test('query is read-only, single-statement, capped, and cannot read email bodies', async () => {
  const { facts } = await sharedWorld();
  assert.throws(() => runQuery(facts.db, 'DELETE FROM invoices'), ToolError);
  assert.throws(() => runQuery(facts.db, 'SELECT 1; SELECT 2'), /one statement/);
  assert.throws(() => runQuery(facts.db, 'SELECT body FROM emails'), /read_email/);
  assert.throws(() => runQuery(facts.db, "WITH x AS (SELECT 1) UPDATE vendors SET status = 'x'"), /SQL error/);
  const r = runQuery(facts.db, 'SELECT invoice_id FROM invoices');
  assert.equal(r.rows.length, 50);
  assert.equal(r.truncated, true);
});

test('read_email marks the text as untrusted and shows the trust flags', async () => {
  const { facts } = await sharedWorld();
  const e = readEmail(facts.db, scenario('bank_change_fraud').email_ids[0]!) as { text: string; trust_flags: unknown[]; warning: string };
  assert.match(e.text, /^<untrusted_email id="m\d+">/);
  assert.equal(e.trust_flags.length, 2);
  assert.match(e.warning, /Untrusted/);
});
