import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { memoryAudit } from '../src/agent/audit';
import { investigate, type RunDeps } from '../src/agent/loop';
import { SYSTEM_PROMPT } from '../src/agent/prompt';
import { childEnv, claudeCodeTransport, mcpName, type AgentSdk } from '../src/llm/claude-code';
import { duplicateInvoices, issueFor, scenario, sharedWorld, vendorRow } from './helpers';

// The Claude Code transport against a fake Agent SDK. The fake captures the in-process MCP
// tools and plays a model that calls them, then emits the result message the CLI would.

type Call = (name: string, args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
type Script = (ctx: { options: Options; call: Call }) => AsyncGenerator<SDKMessage>;

function fakeSdk(script: Script) {
  const seen: { options?: Options; cwdExisted?: boolean } = {};
  let tools: { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }[] = [];
  const sdk: AgentSdk = {
    createSdkMcpServer: ((o: { name: string; tools?: typeof tools }) => {
      tools = o.tools ?? [];
      return { type: 'sdk', name: o.name, instance: {} };
    }) as unknown as AgentSdk['createSdkMcpServer'],
    query({ options }) {
      seen.options = options!;
      seen.cwdExisted = existsSync(options!.cwd!);
      const call: Call = async (name, args) => (await tools.find((t) => mcpName(t.name) === name)!.handler(args, {})) as Awaited<ReturnType<Call>>;
      return script({ options: options!, call });
    },
  };
  return { sdk, seen };
}

const assistant = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null }) as unknown as SDKMessage;
const usage = { input_tokens: 3000, output_tokens: 400, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 };
function result(subtype: string, extra: Record<string, unknown> = {}): SDKMessage {
  return { type: 'result', subtype, is_error: subtype !== 'success', result: '', errors: [], num_turns: 3, total_cost_usd: 0.0421, usage, modelUsage: {}, duration_ms: 1, ...extra } as unknown as SDKMessage;
}

async function run(script: Script, limits?: RunDeps['limits']) {
  const { facts, issues } = await sharedWorld();
  const fake = fakeSdk(script);
  const r = await investigate({ transport: claudeCodeTransport('claude-sonnet-5-5', 'medium', fake.sdk), db: facts.db, issue: issueFor(issues, 'discount_juniper'), duplicateInvoices: duplicateInvoices(issues), audit: memoryAudit(), ...(limits ? { limits } : {}) });
  return { r, seen: fake.seen };
}

const options = [
  { id: 'pay', description: 'Pay now with the discount', consequences: 'saves the discount', chosen: true },
  { id: 'wait', description: 'Do nothing; pay at net terms', consequences: 'loses the discount', chosen: false },
];

test('only our five MCP tools are allowed, with no built-ins, settings, prompts or saved session', async () => {
  const { seen } = await run(async function* () {
    yield result('success', { is_error: false, result: 'nothing to do' });
  });
  const o = seen.options!;
  assert.deepEqual(o.allowedTools, ['query', 'read_email', 'match_check', 'discount_value', 'submit_plan'].map(mcpName));
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.permissionMode, 'dontAsk');
  assert.equal(o.persistSession, false);
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(Object.keys(o.mcpServers!), ['ap']);
  assert.equal(o.systemPrompt, SYSTEM_PROMPT);
  assert.equal(o.maxTurns, 16 + 3 + 4);
  assert.equal(o.model, 'claude-sonnet-5-5');
  assert.equal(seen.cwdExisted, true);
  assert.equal(existsSync(o.cwd!), false, 'the temporary working directory is removed');
});

test('ANTHROPIC_API_KEY is stripped from the Claude Code environment', async () => {
  assert.equal('ANTHROPIC_API_KEY' in childEnv({ ANTHROPIC_API_KEY: 'sk-test', PATH: '/bin' }), false);
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-stray';
  try {
    const { seen } = await run(async function* () {
      yield result('success', { is_error: false });
    });
    assert.equal(seen.options!.env!.ANTHROPIC_API_KEY, undefined);
    assert.equal(seen.options!.env!.PATH, process.env.PATH);
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  }
});

test('a successful run calls our tools through MCP and reports an estimated cost', async () => {
  const s = scenario('discount_juniper');
  const inv = s.invoice_ids[0]!;
  const acct = vendorRow((await sharedWorld()).facts, s.vendor_id).remit_account;
  const { r } = await run(async function* ({ call }) {
    yield assistant('Checking the discount.');
    const d = JSON.parse((await call(mcpName('discount_value'), { invoice_id: inv })).content[0]!.text);
    const plan = { summary: 's', options, outcome: 'act', rationale: 'r', open_questions: [], evidence_ids: [inv], actions: [{ type: 'schedule_payment', invoice_id: inv, amount_cents: d.pay_with_discount_cents, currency: 'USD', take_discount: true, pay_to_account: acct }] };
    const reply = await call(mcpName('submit_plan'), plan);
    assert.match(reply.content[0]!.text, /Plan accepted/);
    yield assistant('Done.');
    yield result('success', { is_error: false, result: 'Done.' });
  });
  assert.equal(r.status, 'planned', r.failure ?? '');
  assert.deepEqual(r.tool_calls.map((c) => c.name), ['discount_value', 'submit_plan']);
  assert.equal(r.transport, 'claude-code');
  assert.equal(r.cost_usd, 0.0421);
  assert.equal(r.cost_estimated, true);
  assert.deepEqual(r.usage, usage);
});

test('hitting max turns fails the run as out of budget', async () => {
  const { r } = await run(async function* () {
    yield result('error_max_turns');
  });
  assert.equal(r.status, 'failed');
  assert.match(r.failure!, /ran out of model turns/);
});

test('error results map to clear failures, including a missing login or CLI', async () => {
  const cases: [Script, RegExp][] = [
    [async function* () { yield result('error_during_execution', { errors: ['upstream exploded'] }); }, /model call failed: upstream exploded/],
    [async function* () { yield result('success', { is_error: true, result: 'Not logged in · Please run /login' }); }, /Claude Code is not available/],
    [async function* () { yield result('error_during_execution', { startup_failure_reason: 'cli_version_too_old' }); }, /Claude Code is not available.*cli_version_too_old/],
    [
      // eslint-disable-next-line require-yield -- the CLI fails to start before any message
      async function* () { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); },
      /Claude Code is not available/,
    ],
    [async function* () { yield result('success', { is_error: false, result: 'I would pay it.' }); }, /ended without submitting/],
  ];
  for (const [script, expected] of cases) {
    const { r } = await run(script);
    assert.equal(r.status, 'failed');
    assert.match(r.failure!, expected);
  }
});

test('the deadline aborts Claude Code and fails the run as timed out', async () => {
  const started = Date.now();
  const { r, seen } = await run(
    async function* ({ options: o }) {
      await new Promise((_, reject) => o.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      yield result('success');
    },
    { deadlineMs: 50 },
  );
  assert.equal(r.status, 'failed');
  assert.match(r.failure!, /deadline/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(seen.options!.abortController!.signal.aborted, true);
});
