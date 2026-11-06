import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { emptyUsage, type UsageTotals } from './cost';
import type { Conversation, Effort, Transport, TransportFailure, TransportResult } from './transport';

// Default live path (LIVE_VIA_CLAUDE_CODE=1): the Agent SDK drives the user's logged-in
// Claude Code, so runs draw on their subscription instead of API billing. Our tools are an
// in-process MCP server and are the only tools the model has: no built-in tools, no settings
// files, no prompts for permission, no saved session, and an empty temporary working directory.

const SERVER = 'ap';
export const mcpName = (tool: string) => `mcp__${SERVER}__${tool}`;

/** The two SDK functions this transport uses. Tests pass fakes. */
export interface AgentSdk {
  query(params: { prompt: string; options?: Options }): AsyncIterable<SDKMessage>;
  createSdkMcpServer: typeof sdk.createSdkMcpServer;
}
const realSdk: AgentSdk = { query: (p) => sdk.query(p), createSdkMcpServer: sdk.createSdkMcpServer };

/** The parent environment without ANTHROPIC_API_KEY, so a stray key never overrides the login. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const { ANTHROPIC_API_KEY: _key, ...rest } = env;
  return { ...rest, CLAUDE_AGENT_SDK_CLIENT_APP: 'ap-exceptions-copilot/0.1' };
}

const LOGIN_PROBLEM = /not logged in|log ?in|authenticat|oauth|credential|invalid api key/i;
const NOT_INSTALLED = /ENOENT|not found|executable|spawn/i;

function usageOf(u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): UsageTotals {
  return { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 };
}

export function claudeCodeTransport(model: string, effort: Effort, agentSdk: AgentSdk = realSdk): Transport {
  return {
    name: 'claude-code',
    model,
    async run(c: Conversation): Promise<TransportResult> {
      let usage = emptyUsage();
      let cost: number | null = null;
      const end = (ended: TransportResult['ended'], detail: string | null = null): TransportResult => ({ ended, detail, usage, cost_usd: cost, cost_estimated: true });

      const abort = new AbortController();
      let stopped = false;
      let timedOut = false;
      const remaining = c.deadline - Date.now();
      if (remaining <= 0) return end('timeout');
      const timer = setTimeout(() => ((timedOut = true), abort.abort()), remaining);

      const server = agentSdk.createSdkMcpServer({
        name: SERVER,
        version: '1.0.0',
        tools: c.tools.map((t) =>
          sdk.tool(t.name, t.description, t.input.shape, async (args) => {
            const r = await c.call(t.name, args);
            // Not aborted here: letting the model end its turn keeps the result message, with usage and cost.
            if (r.stop) stopped = true;
            return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
          }),
        ),
      });

      const cwd = mkdtempSync(join(tmpdir(), 'apx-claude-'));
      const options: Options = {
        model,
        effort,
        systemPrompt: c.system,
        mcpServers: { [SERVER]: server },
        strictMcpConfig: true,
        tools: [], // no built-in tools
        allowedTools: c.tools.map((t) => mcpName(t.name)),
        settingSources: [],
        permissionMode: 'dontAsk',
        persistSession: false,
        cwd,
        maxTurns: c.maxTurns,
        abortController: abort,
        env: childEnv(),
      };

      let stderr = '';
      options.stderr = (d) => (stderr = (stderr + d).slice(-2000));
      let failure: { code: TransportFailure; detail: string } | null = null;
      try {
        for await (const m of agentSdk.query({ prompt: c.user, options })) {
          if (m.type === 'assistant') {
            c.onTurn?.(m.message.content);
            if (m.error && !failure) failure = { code: LOGIN_PROBLEM.test(m.error) ? 'cli_unavailable' : 'model_error', detail: m.error };
          } else if (m.type === 'result') {
            usage = usageOf(m.usage);
            cost = m.total_cost_usd;
            if (stopped) return end('stopped');
            if (m.subtype === 'success') {
              if (!m.is_error) return end('no_tool_call', m.result.slice(0, 500));
              return end(failure?.code ?? (LOGIN_PROBLEM.test(m.result) ? 'cli_unavailable' : 'model_error'), m.result.slice(0, 500));
            }
            if (m.subtype === 'error_max_turns' || m.subtype === 'error_max_budget_usd') return end('budget', m.subtype);
            const detail = [m.startup_failure_reason, ...m.errors].filter(Boolean).join('; ') || m.subtype;
            return end(failure?.code ?? (m.startup_failure_reason || LOGIN_PROBLEM.test(detail) ? 'cli_unavailable' : 'model_error'), detail);
          }
        }
        if (stopped) return end('stopped');
        return failure ? end(failure.code, failure.detail) : end('model_error', 'Claude Code ended without a result');
      } catch (err) {
        if (stopped) return end('stopped');
        if (timedOut) return end('timeout');
        const message = `${(err as Error).message} ${stderr}`.trim();
        if (NOT_INSTALLED.test(message) || LOGIN_PROBLEM.test(message)) return end('cli_unavailable', message.slice(0, 500));
        return end('model_error', message.slice(0, 500));
      } finally {
        clearTimeout(timer);
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}
