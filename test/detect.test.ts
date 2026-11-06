import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUSINESS_DATE } from '../src/config';
import { detectIssues } from '../src/detect/index';
import { rank } from '../src/detect/rank';
import { fixtureExtractions } from './fixtures/extractions';
import { facts, scenario, truth } from './helpers';

const withEmails = () => facts(fixtureExtractions());

test('every planted scenario is detected, and nothing else', async () => {
  const issues = detectIssues((await withEmails()).db);
  const expected = truth.scenarios.map((s) => `${s.kind}:${[...s.invoice_ids].sort().join(',')}`).sort();
  const found = issues.map((i) => `${i.type}:${i.type.startsWith('bank') || i.type.startsWith('susp') ? '' : [...i.invoice_ids].sort().join(',')}`);
  assert.equal(issues.length, truth.scenarios.length);
  for (const s of truth.scenarios) {
    const hit = issues.find((i) => i.type === s.kind && s.invoice_ids.every((id) => i.invoice_ids.includes(id)));
    assert.ok(hit, `scenario ${s.id} not detected (found ${found.join(' | ')}; expected ${expected.join(' | ')})`);
  }
});

test('noise emails create no issues', async () => {
  const issues = detectIssues((await withEmails()).db);
  const noisy = issues.filter((i) => i.email_ids.some((e) => truth.noise_email_ids.includes(e)));
  assert.deepEqual(noisy, []);
});

test('the duplicate is one issue covering both copies, due today because one is approved', async () => {
  const s = scenario('duplicate_invoice');
  const issue = detectIssues((await withEmails()).db).find((i) => i.type === 'duplicate_invoice')!;
  assert.deepEqual([...issue.invoice_ids].sort(), [...s.invoice_ids].sort());
  assert.equal(issue.deadline, BUSINESS_DATE);
  assert.equal(issue.money_at_risk_usd_cents, s.facts.total_cents);
  assert.deepEqual(issue.email_ids, s.email_ids);
  // The copy approved for this run is kept as the original; the emailed one is the copy.
  assert.equal(issue.details.kept_invoice_id, s.invoice_ids[0]);
  assert.deepEqual(issue.details.copy_invoice_ids, [s.invoice_ids[1]]);
  assert.equal(issue.details.kept_because, 'already approved');
});

test('match exceptions carry the disputed amount', async () => {
  const issues = detectIssues((await withEmails()).db);
  for (const id of ['price_variance', 'quantity_variance']) {
    const s = scenario(id);
    const issue = issues.find((i) => i.issue_id === `match-${s.invoice_ids[0]}`)!;
    assert.equal(issue.details.disputed_cents, s.facts.overbilled_cents);
  }
});

test('discounts outside the window are not flagged', async () => {
  const issues = detectIssues((await withEmails()).db).filter((i) => i.type === 'discount_expiring');
  assert.deepEqual(issues.map((i) => i.invoice_ids[0]).sort(), [scenario('discount_juniper').invoice_ids[0], scenario('discount_kestrel').invoice_ids[0]].sort());
});

test('bank-change requests carry trust flags and earlier notes from the same domain', async () => {
  const issues = detectIssues((await withEmails()).db);
  const fraud = issues.find((i) => i.issue_id === `bank-${scenario('bank_change_fraud').email_ids[0]}`)!;
  assert.deepEqual((fraud.details.flags as { flag: string }[]).map((f) => f.flag), ['lookalike_domain', 'reply_to_mismatch']);
  assert.equal(fraud.vendor_id, scenario('bank_change_fraud').vendor_id);
  const genuine = issues.find((i) => i.issue_id === `bank-${scenario('bank_change_genuine').email_ids[1]}`)!;
  assert.deepEqual(genuine.details.flags, []);
  assert.deepEqual([...genuine.email_ids].sort(), [...scenario('bank_change_genuine').email_ids].sort());
  // a suspicious_message is not also raised for an email that is already a bank-change issue
  assert.equal(issues.filter((i) => i.email_ids[0] === fraud.email_ids[0]).length, 1);
});

test('without extractions, code-only flags still catch the look-alike sender', async () => {
  const issues = detectIssues((await facts()).db);
  const email = scenario('bank_change_fraud').email_ids[0];
  assert.ok(issues.some((i) => i.issue_id === `msg-${email}` && i.type === 'suspicious_message'));
});

test('a late receipt removes the quantity exception; an amended PO removes the price exception', async () => {
  const qty = scenario('quantity_variance');
  const price = scenario('price_variance');
  const overlay = `INSERT INTO receipts VALUES ('R-OVERLAY', '${qty.facts.po_line_id}', 40, '2026-03-12', 'overlay');
                   UPDATE po_lines SET unit_price_cents = 1985 WHERE po_line_id = '${price.facts.po_line_id}';`;
  const issues = detectIssues((await facts(fixtureExtractions(), overlay)).db);
  assert.ok(!issues.some((i) => i.type === 'match_exception'));
});

test('ranking explains its inputs and orders by score', async () => {
  const issues = detectIssues((await withEmails()).db);
  for (let i = 1; i < issues.length; i++) assert.ok(issues[i - 1]!.ranking.score >= issues[i]!.ranking.score);
  const r = rank({ ...issues[0]!, money_at_risk_usd_cents: 99_900, deadline: BUSINESS_DATE, details: { flags: [{}, {}] } });
  assert.deepEqual([r.money_points, r.urgency_points, r.flag_points, r.score], [3, 3, 2, 8]);
  assert.match(r.explanation, /\$999\.00 at risk/);
});

test('a flagged email and the match failure it asks to skip are one issue', async () => {
  const s = scenario('prompt_injection');
  const inv = s.invoice_ids[0]!;
  const issues = detectIssues((await withEmails()).db);
  const msg = issues.find((i) => i.issue_id === `msg-${s.email_ids[0]}`)!;
  assert.deepEqual(msg.details.match_exceptions, [{ invoice_id: inv, disputed_cents: s.facts.overbilled_cents }]);
  assert.match(msg.title, new RegExp(`${inv} is \\$2,415\\.00 over`));
  assert.equal(issues.some((i) => i.issue_id === `match-${inv}`), false);
  // Without the email's extraction there is no flag, so the shortfall is a plain match exception.
  assert.ok(detectIssues((await facts()).db).some((i) => i.issue_id === `match-${inv}`));
});
