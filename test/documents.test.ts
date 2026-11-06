import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { renderDocument } from '../src/actions/documents';
import { ActionSchema } from '../src/actions/schema';
import { scenario, sharedWorld, vendorRow } from './helpers';

test('a short pay says the vendor sees the withheld amount; a hold says nothing is sent', async () => {
  const { facts } = await sharedWorld();
  const s = scenario('price_variance');
  const v = vendorRow(facts, s.vendor_id);
  const doc = renderDocument({ type: 'short_pay', invoice_id: s.invoice_ids[0]!, pay_cents: 817_200, disputed_cents: 43_500, currency: 'USD', pay_to_account: v.remit_account, reason: 'Price above PO' }, facts.db);
  assert.match(doc.body!, /Remittance advice[\s\S]*Withheld \$435\.00 as disputed\.\nReason: Price above PO/);
  assert.ok(doc.fields.some(([k, val]) => k === 'Vendor sees' && val.includes(v.contact_email)));

  // The model sees the same semantics in the action schemas.
  const schema = JSON.stringify(z.toJSONSchema(ActionSchema));
  assert.match(schema, /Visible to the vendor: pays the matched amount and sends the vendor a remittance advice/);
  assert.match(schema, /Internal: takes the invoice out of this payment run\. Nothing is sent to the vendor\./);
});
