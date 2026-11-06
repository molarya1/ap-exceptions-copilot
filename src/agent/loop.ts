import type Anthropic from '@anthropic-ai/sdk';
import { AGENT_LIMITS } from '../config';
import type { Issue } from '../detect/types';
import type { Db } from '../lib/sqlite';
import type { Audit } from './audit';
import { checkPlan } from './checks';
import { addUsage, costUsd, emptyUsage, type UsageTotals } from './cost';
import type { Plan } from './plan';
import { PlanSchema } from './plan';
import { issueBrief, SYSTEM_PROMPT } from './prompt';
import { executeTool, ToolError, TOOL_DEFS, TOOL_INPUTS, type RunState, type ToolName } from './tools';

// One run: one investigation of one issue, as a Messages API tool loop.
// The loop owns the limits; the model owns nothing but its tool calls.

/** The slice of the Anthropic client the loop needs. Tests and replay pass fakes. */
export interface MessagesApi {
  create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RunDeps {
  api: MessagesApi;
  db: Db;
  issue: Issue;
  duplicateInvoices: ReadonlySet<string>;
  model: string;
  effort: Effort;
  audit: Audit;
  limits?: Partial<typeof AGENT_LIMITS>;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

export interface RunResult {
  status: 'planned' | 'failed';
  plan: Plan | null;
  failure: string | null;
  tool_calls: ToolCallRecord[];
  responses: Anthropic.Message[];
  usage: UsageTotals;
  cost_usd: number | null;
  duration_ms: number;
  model: string;
}

export async function investigate(deps: RunDeps): Promise<RunResult> {
  const limits = { ...AGENT_LIMITS, ...deps.limits };
  const started = Date.now();
  const state: RunState = { calc: new Map() };
  const toolCalls: ToolCallRecord[] = [];
  const responses: Anthropic.Message[] = [];
  const usage = emptyUsage();
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: issueBrief(deps.issue) }];
  let budgetUsed = 0;
  let planRejections = 0;
  let nudged = false;

  const finish = (status: RunResult['status'], plan: Plan | null, failure: string | null): RunResult => {
    deps.audit.write({ kind: 'run_end', status, failure, tool_calls: toolCalls.length, usage });
    return { status, plan, failure, tool_calls: toolCalls, responses, usage, cost_usd: costUsd(deps.model, usage), duration_ms: Date.now() - started, model: deps.model };
  };

  deps.audit.write({ kind: 'run_start', issue_id: deps.issue.issue_id, model: deps.model, effort: deps.effort });

  const maxTurns = limits.maxToolCalls + limits.extraPlanAttempts + 4;
  for (let turn = 0; ; turn++) {
    if (turn >= maxTurns) return finish('failed', null, `no plan after ${maxTurns} model turns`);
    const remaining = limits.deadlineMs - (Date.now() - started);
    if (remaining <= 0) return finish('failed', null, 'wall-clock deadline reached');

    let response: Anthropic.Message;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), remaining);
    try {
      response = await deps.api.create(
        {
          model: deps.model,
          max_tokens: 16_000,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          tools: TOOL_DEFS,
          messages,
          output_config: { effort: deps.effort },
        },
        { signal: abort.signal },
      );
    } catch (err) {
      deps.audit.write({ kind: 'api_error', message: (err as Error).message });
      return finish('failed', null, `model call failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    responses.push(response);
    addUsage(usage, response.usage);
    deps.audit.write({ kind: 'model_turn', stop_reason: response.stop_reason, content: response.content, usage: response.usage });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') return finish('failed', null, 'the model declined the request');
    if (response.stop_reason === 'max_tokens') return finish('failed', null, 'the response hit max_tokens');

    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (uses.length === 0) {
      if (nudged) return finish('failed', null, 'ended without submitting a plan');
      nudged = true;
      messages.push({ role: 'user', content: 'Finish by calling submit_plan with your decision.' });
      continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let accepted: Plan | null = null;
    for (const use of uses) {
      const reply = (content: unknown, isError = false) => {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: typeof content === 'string' ? content : JSON.stringify(content), ...(isError ? { is_error: true } : {}) });
      };

      if (use.name === 'submit_plan') {
        const parsed = PlanSchema.safeParse(use.input);
        const problems = parsed.success
          ? checkPlan(parsed.data, { db: deps.db, issue: deps.issue, runCalc: state.calc, duplicateInvoices: deps.duplicateInvoices })
          : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
        toolCalls.push({ name: use.name, input: use.input, ...(problems.length ? { error: problems.join('\n') } : { output: 'accepted' }) });
        deps.audit.write({ kind: problems.length ? 'plan_rejected' : 'plan_accepted', input: use.input, problems });
        if (problems.length === 0) {
          accepted = parsed.data!;
          reply('Plan accepted. It will be shown to a person for approval.');
        } else {
          planRejections++;
          reply({ problems }, true);
        }
        continue;
      }

      if (!(use.name in TOOL_INPUTS)) {
        toolCalls.push({ name: use.name, input: use.input, error: 'unknown tool' });
        reply(`Unknown tool ${use.name}.`, true);
        continue;
      }
      if (budgetUsed >= limits.maxToolCalls) {
        toolCalls.push({ name: use.name, input: use.input, error: 'tool budget exhausted' });
        deps.audit.write({ kind: 'tool_refused', name: use.name, reason: 'budget' });
        reply(`Tool budget of ${limits.maxToolCalls} calls is used up. Submit your plan now.`, true);
        continue;
      }
      budgetUsed++;
      try {
        const output = executeTool(deps.db, state, use.name as Exclude<ToolName, 'submit_plan'>, use.input);
        toolCalls.push({ name: use.name, input: use.input, output });
        deps.audit.write({ kind: 'tool_call', name: use.name, input: use.input, output });
        reply(output);
      } catch (err) {
        const message = err instanceof ToolError ? err.message : `Invalid input: ${(err as Error).message}`;
        toolCalls.push({ name: use.name, input: use.input, error: message });
        deps.audit.write({ kind: 'tool_error', name: use.name, input: use.input, error: message });
        reply(message, true);
      }
    }

    if (accepted) return finish('planned', accepted, null);
    if (planRejections > limits.extraPlanAttempts) return finish('failed', null, `plan rejected ${planRejections} times`);
    messages.push({ role: 'user', content: results });
  }
}
