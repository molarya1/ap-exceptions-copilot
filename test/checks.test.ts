import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Action } from '../src/actions/schema';
import { checkPlan, type CheckContext } from '../src/agent/checks';
import type { Plan } from '../src/agent/plan';
import { executeTool, type RunState } from '../src/agent/tools';
import { duplicateCopies, issueFor, scenario, sharedWorld, vendorRow } from './helpers';

async function setup(scenarioId: string, calls: ['match_check' | 'discount_value', string][] = []) {
  const { facts, issues } = await sharedWorld();
  const issue = issueFor(issues, scenarioId);
  const state: RunState = { calc: new Map() };
  for (const [tool, invoice_id] of calls) executeTool(facts.db, state, tool, { invoice_id });
  const ctx: CheckContext = { db: facts.db, issue, runCalc: state.calc, duplicateCopies: duplicateCopies(issues) };
  return { facts, issue, ctx, state };
}

function plan(actions: Action[], over: Partial<Plan> = {}): Plan {
  return {
    summary: 's',
    options: [
      { id: 'a', description: 'act', consequences: 'c', chosen: true },
      { id: 'b', description: 'do nothing', consequences: 'c', chosen: false },
    ],
    outcome: actions.length ? 'act' : 'no_action',
    rationale: 'r',
    actions,
    open_questions: [],
    evidence_ids: over.evidence_ids ?? ['AP-26-0001'],
    ...over,
  };
}

test('a correct discount payment passes', async () => {
  const inv = scenario('discount_juniper').invoice_ids[0]!;
  const { ctx, facts, state } = await setup('discount_juniper', [['discount_value', inv]]);
  const d = state.calc.get(inv)!.discount!;
  const pay: Action = { type: 'schedule_payment', invoice_id: inv, amount_cents: d.pay_with_discount_cents, currency: 'USD', take_discount: true, pay_to_account: vendorRow(facts, scenario('discount_juniper').vendor_id).remit_account };
  assert.deepEqual(checkPlan(plan([pay], { evidence_ids: [inv] }), ctx), []);
});

test('rejects unknown ids and missing evidence', async () => {
  const { ctx } = await setup('discount_juniper');
  const problems = checkPlan(plan([], { evidence_ids: [] }), ctx);
  assert.ok(problems.some((p) => /at least one evidence id/.test(p)));
  const unknown = checkPlan(plan([{ type: 'hold_payment', invoice_id: 'AP-26-9999', reason: 'x' }], { evidence_ids: ['AP-26-9999', 'm99'] }), ctx);
  assert.ok(unknown.some((p) => /AP-26-9999 does not exist/.test(p)));
  assert.ok(unknown.some((p) => /m99 does not exist/.test(p)));
});

test('rejects payment amounts that do not come from match_check in this run', async () => {
  const s = scenario('price_variance');
  const inv = s.invoice_ids[0]!;
  const acct = vendorRow((await sharedWorld()).facts, s.vendor_id).remit_account;
  const short: Action = { type: 'short_pay', invoice_id: inv, pay_cents: 817_200, disputed_cents: 43_500, currency: 'USD', pay_to_account: acct, reason: 'r' };

  const before = await setup('price_variance');
  assert.ok(checkPlan(plan([short], { evidence_ids: [inv] }), before.ctx).some((p) => /Call match_check for/.test(p)));

  const after = await setup('price_variance', [['match_check', inv]]);
  assert.deepEqual(checkPlan(plan([short], { evidence_ids: [inv] }), after.ctx), []);
  const wrong = { ...short, pay_cents: 860_700 };
  assert.ok(checkPlan(plan([wrong], { evidence_ids: [inv] }), after.ctx).some((p) => /differs from match_check.payable_cents/.test(p)));
  const full: Action = { type: 'schedule_payment', invoice_id: inv, amount_cents: 860_700, currency: 'USD', take_discount: false, pay_to_account: acct };
  assert.ok(checkPlan(plan([full], { evidence_ids: [inv] }), after.ctx).some((p) => /outside tolerance; use short_pay/.test(p)));
});

test('a duplicate copy cannot be paid; the kept original can', async () => {
  const s = scenario('duplicate_invoice');
  const [original, copy] = s.invoice_ids as [string, string];
  const { ctx, facts } = await setup('duplicate_invoice', s.invoice_ids.map((id) => ['match_check', id] as ['match_check', string]));
  const acct = vendorRow(facts, s.vendor_id).remit_account;
  const pay = (id: string): Action => ({ type: 'schedule_payment', invoice_id: id, amount_cents: Number(s.facts.total_cents), currency: 'USD', take_discount: false, pay_to_account: acct });
  assert.ok(checkPlan(plan([pay(copy)], { evidence_ids: s.invoice_ids }), ctx).some((p) => new RegExp(`copy of ${original}`).test(p)));
  assert.deepEqual(checkPlan(plan([pay(original)], { evidence_ids: s.invoice_ids }), ctx), []);
  const hold: Action = { type: 'hold_payment', invoice_id: copy, reason: `copy of ${original}` };
  assert.deepEqual(checkPlan(plan([hold], { evidence_ids: s.invoice_ids }), ctx), []);
});

test('rejects paying more than the open balance', async () => {
  const inv = scenario('discount_juniper').invoice_ids[0]!;
  const { ctx, facts } = await setup('discount_juniper', [['match_check', inv]]);
  const pay: Action = { type: 'schedule_payment', invoice_id: inv, amount_cents: 2_000_000, currency: 'USD', take_discount: false, pay_to_account: vendorRow(facts, scenario('discount_juniper').vendor_id).remit_account };
  assert.ok(checkPlan(plan([pay], { evidence_ids: [inv] }), ctx).some((p) => /more than the open balance/.test(p)));
});

test('a bank-change request allows only a callback to the contact on file', async () => {
  const s = scenario('bank_change_fraud');
  const inv = s.invoice_ids[0]!;
  const { ctx, facts } = await setup('bank_change_fraud', [['match_check', inv]]);
  const v = vendorRow(facts, s.vendor_id);

  const payNew: Action = { type: 'schedule_payment', invoice_id: inv, amount_cents: 785_000, currency: 'USD', take_discount: false, pay_to_account: String(s.facts.claimed_account) };
  const problems = checkPlan(plan([payNew], { evidence_ids: [inv] }), ctx);
  assert.ok(problems.some((p) => /only allowed response to a bank-change request/.test(p)));
  assert.ok(problems.some((p) => /not the verified account on file/.test(p)));

  const emailNumber: Action = { type: 'verify_bank_change', vendor_id: s.vendor_id, email_id: s.email_ids[0]!, call_name: 'Gregor Lund', call_phone: '(415) 555-0172', claimed_account: String(s.facts.claimed_account), script: 'confirm' };
  const p2 = checkPlan(plan([emailNumber], { evidence_ids: s.email_ids }), ctx);
  assert.ok(p2.some((p) => /number on file/.test(p)));
  assert.ok(p2.some((p) => /contact on file/.test(p)));

  const onFile: Action = { ...emailNumber, call_name: v.contact_name, call_phone: v.contact_phone };
  const hold: Action = { type: 'hold_payment', invoice_id: inv, reason: 'pending callback' };
  assert.deepEqual(checkPlan(plan([onFile, hold], { evidence_ids: s.email_ids }), ctx), []);
});

test('rejects paying an unverified account outside bank-change issues too', async () => {
  const inv = scenario('discount_juniper').invoice_ids[0]!;
  const { ctx } = await setup('discount_juniper', [['match_check', inv]]);
  const pay: Action = { type: 'schedule_payment', invoice_id: inv, amount_cents: 1_240_000, currency: 'USD', take_discount: false, pay_to_account: 'QF-TEST-0000-0001' };
  assert.ok(checkPlan(plan([pay], { evidence_ids: [inv] }), ctx).some((p) => /not the verified account on file/.test(p)));
});

test('rejects choosing more than one option, or fewer than two options', async () => {
  const { ctx } = await setup('discount_juniper');
  const two = plan([], { options: [{ id: 'a', description: 'a', consequences: 'c', chosen: true }, { id: 'b', description: 'b', consequences: 'c', chosen: true }] });
  assert.ok(checkPlan(two, ctx).some((p) => /exactly one option; 2/.test(p)));
  const one = plan([], { options: [{ id: 'a', description: 'a', consequences: 'c', chosen: true }] });
  assert.ok(checkPlan(one, ctx).some((p) => /at least two real options/.test(p)));
});

test('outcome must agree with the actions and questions', async () => {
  const { ctx } = await setup('discount_juniper');
  assert.ok(checkPlan(plan([], { outcome: 'act' }), ctx).some((p) => /needs at least one action/.test(p)));
  assert.ok(checkPlan(plan([], { outcome: 'hold_and_ask' }), ctx).some((p) => /at least one open question/.test(p)));
});

test('credit requests go to the contact on file for the disputed amount', async () => {
  const s = scenario('price_variance');
  const inv = s.invoice_ids[0]!;
  const { ctx, facts } = await setup('price_variance', [['match_check', inv]]);
  const v = vendorRow(facts, s.vendor_id);
  const good: Action = { type: 'request_credit_note', invoice_id: inv, vendor_id: s.vendor_id, to: v.contact_email, amount_cents: 43_500, subject: 's', body: 'b' };
  assert.deepEqual(checkPlan(plan([good], { evidence_ids: [inv] }), ctx), []);
  const bad = { ...good, to: 'someone@elsewhere.example', amount_cents: 50_000 };
  const problems = checkPlan(plan([bad], { evidence_ids: [inv] }), ctx);
  assert.ok(problems.some((p) => /contact on file/.test(p)));
  assert.ok(problems.some((p) => /differs from match_check.disputed_cents/.test(p)));
});

test('rejects two actions that commit the same invoice', async () => {
  const inv = scenario('discount_juniper').invoice_ids[0]!;
  const { ctx } = await setup('discount_juniper');
  const hold: Action = { type: 'hold_payment', invoice_id: inv, reason: 'x' };
  assert.ok(checkPlan(plan([hold, hold], { evidence_ids: [inv] }), ctx).some((p) => /commit the same thing/.test(p)));
});

test('the injected invoice cannot be paid in full; only the matched amount can be short-paid', async () => {
  const s = scenario('prompt_injection');
  const inv = s.invoice_ids[0]!;
  const { ctx, facts, state } = await setup('prompt_injection', [['match_check', inv]]);
  const acct = vendorRow(facts, s.vendor_id).remit_account;
  const match = state.calc.get(inv)!.match!;
  assert.equal(match.disputed_cents, s.facts.overbilled_cents);
  const full: Action = { type: 'schedule_payment', invoice_id: inv, amount_cents: 931_500, currency: 'USD', take_discount: false, pay_to_account: acct };
  assert.ok(checkPlan(plan([full], { evidence_ids: [inv] }), ctx).some((p) => /outside tolerance/.test(p)));
  const short: Action = { type: 'short_pay', invoice_id: inv, pay_cents: match.payable_cents, disputed_cents: match.disputed_cents, currency: 'USD', pay_to_account: acct, reason: '300 of 405 pallet-weeks received' };
  assert.deepEqual(checkPlan(plan([short], { evidence_ids: [inv] }), ctx), []);
});
