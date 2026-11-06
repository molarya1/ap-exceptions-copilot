import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractAll, type ExtractionModel } from '../src/extract/extract';
import type { Extraction } from '../src/extract/schema';
import { trustFlags } from '../src/extract/trust';
import { verifyExtraction } from '../src/extract/verify';
import { loadInbox } from '../src/ingest/build';
import { fixtureExtractions, rawFixtureExtractions } from './fixtures/extractions';
import { facts, scenario } from './helpers';

const inbox = loadInbox('data');
const email = (id: string) => inbox.find((e) => e.emailId === id)!;

test('claims whose quote is not in the email are dropped', () => {
  const e = email(scenario('bank_change_fraud').email_ids[0]!);
  const raw: Extraction = {
    intent: 'bank_change', summary: 'x', suspected_instructions: [],
    claims: [
      { kind: 'bank_account', value: 'QF-TEST-8812-0457', quote: 'Account: QF-TEST-8812-0457' },
      { kind: 'bank_account', value: 'QF-TEST-0000-0000', quote: 'Account: QF-TEST-0000-0000' }, // invented
      { kind: 'amount', value: '$9,999.00', quote: 'release payment of $7,850.00' }, // value not in quote
    ],
  };
  const v = verifyExtraction(e, raw);
  assert.equal(v.claims.length, 1);
  assert.equal(v.droppedClaims, 2);
});

test('embedded_instructions is set only when code finds the quoted text', () => {
  const e = email(scenario('prompt_injection').email_ids[0]!);
  const real = verifyExtraction(e, rawFixtureExtractions().get(e.emailId)!);
  assert.deepEqual(trustFlags(e, [], real).map((f) => f.flag), ['embedded_instructions']);

  const invented = verifyExtraction(e, { intent: 'invoice', summary: 'x', claims: [], suspected_instructions: [{ quote: 'ignore all previous instructions', why: 'x' }] });
  assert.deepEqual(trustFlags(e, [], invented), []);
});

test('extractions are cached and reused; a changed email is extracted again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apx-'));
  const cachePath = join(dir, 'extractions.json');
  const raw = rawFixtureExtractions();
  let calls = 0;
  const fake: ExtractionModel = { model: 'fake', extract: async (e) => (calls++, raw.get(e.emailId)!) };

  const first = await extractAll(inbox, cachePath, fake);
  assert.equal(calls, inbox.length);
  assert.equal(first.extractions.size, inbox.length);

  const second = await extractAll(inbox, cachePath, fake);
  assert.equal(calls, inbox.length);
  assert.deepEqual([...second.extractions.keys()], [...first.extractions.keys()]);

  const edited = inbox.map((e, i) => (i === 0 ? { ...e, body: e.body + '\nP.S. edited' } : e));
  await extractAll(edited, cachePath, fake);
  assert.equal(calls, inbox.length + 1);
  assert.ok(JSON.parse(readFileSync(cachePath, 'utf8')).entries[inbox[0]!.emailId]);
});

test('with no cache and no key, emails are reported missing rather than guessed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apx-'));
  const result = await extractAll(inbox, join(dir, 'none.json'));
  assert.equal(result.extractions.size, 0);
  assert.equal(result.missing.length, inbox.length);
});

test('verified extractions land in facts.db with their claimed bank account', async () => {
  const { db } = await facts(fixtureExtractions());
  const s = scenario('bank_change_genuine');
  const row = db.get<{ intent: string; new_bank_account: string }>('SELECT intent, new_bank_account FROM email_extractions WHERE email_id = ?', [s.email_ids[1]!]);
  assert.deepEqual(row, { intent: 'bank_change', new_bank_account: s.facts.claimed_account });
  const flags = db.all<{ email_id: string; flag: string }>('SELECT email_id, flag FROM email_flags ORDER BY email_id, flag');
  assert.deepEqual(flags.map((f) => f.flag), ['embedded_instructions', 'lookalike_domain', 'reply_to_mismatch']);
});
