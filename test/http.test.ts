import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { App } from '../src/app';
import { createApp } from '../src/server/http';
import { testApp } from './fixtures/test-app';

let app: App;
let server: Server;
let port: number;

before(async () => {
  app = await testApp();
  port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
  server = createApp(app, port);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
});
after(() => server.close());

const base = () => `http://localhost:${port}`;
async function session(): Promise<string> {
  const res = await fetch(`${base()}/`);
  const cookie = res.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  return cookie.split(';')[0]!;
}
const post = (path: string, body: unknown, headers: Record<string, string>) => fetch(`${base()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function pendingAction(): Promise<{ action_id: string; payload_hash: string }> {
  const res = await fetch(`${base()}/api/approvals`);
  const data = (await res.json()) as { pending: { action_id: string; payload_hash: string; type: string }[] };
  return data.pending.find((a) => a.type === 'schedule_payment')!;
}

test('pages carry a strict CSP and a session cookie', async () => {
  const res = await fetch(`${base()}/`);
  assert.match(res.headers.get('content-security-policy')!, /default-src 'none'; script-src 'self'/);
  assert.ok(res.headers.get('set-cookie'));
});

test('an unknown Host header is refused', async () => {
  const res = await new Promise<number>((resolve) => {
    import('node:http').then(({ request }) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/issues', headers: { host: `evil.example:${port}` } }, (r) => resolve(r.statusCode!));
      req.end();
    });
  });
  assert.equal(res, 421);
});

test('state-changing requests need an allowed Origin', async () => {
  const cookie = await session();
  const a = await pendingAction();
  assert.equal((await post(`/api/actions/${a.action_id}/approve`, { payload_hash: a.payload_hash }, { cookie })).status, 403);
  assert.equal((await post(`/api/actions/${a.action_id}/approve`, { payload_hash: a.payload_hash }, { cookie, origin: 'http://evil.example' })).status, 403);
});

test('without a session there is no capability, so approval is refused', async () => {
  const a = await pendingAction();
  const res = await post(`/api/actions/${a.action_id}/approve`, { payload_hash: a.payload_hash }, { origin: base() });
  assert.equal(res.status, 401);
  const forged = await post(`/api/actions/${a.action_id}/approve`, { payload_hash: a.payload_hash }, { origin: base(), cookie: `apx_session=${'0'.repeat(64)}` });
  assert.equal(forged.status, 401);
});

test('a wrong hash is refused; the right one approves once', async () => {
  const cookie = await session();
  const a = await pendingAction();
  const wrong = await post(`/api/actions/${a.action_id}/approve`, { payload_hash: 'x' }, { cookie, origin: base() });
  assert.equal(wrong.status, 409);
  const ok = await post(`/api/actions/${a.action_id}/approve`, { payload_hash: a.payload_hash }, { cookie, origin: base() });
  assert.equal(ok.status, 200);
  const twice = await post(`/api/actions/${a.action_id}/approve`, { payload_hash: a.payload_hash }, { cookie, origin: base() });
  assert.equal(twice.status, 409);
  const outbox = ((await (await fetch(`${base()}/api/approvals`)).json()) as { outbox: { action_id: string }[] }).outbox;
  assert.ok(outbox.some((o) => o.action_id === a.action_id));
});

test('malformed or oversized bodies get 400 with a fixed message', async () => {
  const cookie = await session();
  const a = await pendingAction();
  const raw = (body: string) => fetch(`${base()}/api/actions/${a.action_id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: base() }, body });
  for (const [body, message] of [['{"payload_hash": ', 'request body is not valid JSON'], ['[1, 2]', 'request body must be a JSON object'], ['null', 'request body must be a JSON object'], [`{"reason": "${'x'.repeat(70_000)}"}`, 'request body is too large']] as const) {
    const res = await raw(body);
    assert.equal(res.status, 400, body.slice(0, 20));
    assert.deepEqual(await res.json(), { error: message });
  }
});

test('issue view includes evidence cards, actions with documents, and the tool trail', async () => {
  const issues = (await (await fetch(`${base()}/api/issues`)).json()) as { issue_id: string; type: string }[];
  const fraud = issues.find((i) => i.type === 'bank_change_request' && i.issue_id === 'bank-m14')!;
  const view = (await (await fetch(`${base()}/api/issues/${fraud.issue_id}`)).json()) as { evidence: { kind: string; flags?: unknown[] }[]; actions: { document: { kind: string } }[]; run: { trail: unknown[] } };
  assert.ok(view.evidence.some((e) => e.kind === 'email' && (e.flags?.length ?? 0) === 2));
  assert.equal(view.actions[0]!.document.kind, 'callback_task');
  assert.ok(view.run.trail.length > 1);
});
