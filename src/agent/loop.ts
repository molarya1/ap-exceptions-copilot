import { AGENT_LIMITS } from '../config';
import type { Issue } from '../detect/types';
import type { Db } from '../lib/sqlite';
import type { Audit } from './audit';
import { checkPlan } from './checks';
import type { UsageTotals } from '../llm/cost';
import type { Plan } from './plan';
import { PlanSchema } from './plan';
import { issueBrief, SYSTEM_PROMPT } from './prompt';
import { executeTool, ToolError, TOOL_INPUTS, TOOL_SPECS, type RunState, type ToolName } from './tools';
import { FAILURE_TEXT, type ToolReply, type Transport } from '../llm/transport';

// One run: one investigation of one issue. The loop owns the limits, the checks and the
// audit log; the transport only carries the conversation. The model owns nothing but its
// tool calls.

export type { Effort } from '../llm/transport';

export interface RunDeps {
  transport: Transport;
  db: Db;
  issue: Issue;
  duplicateCopies: ReadonlyMap<string, string>;
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
  usage: UsageTotals;
  cost_usd: number | null;
  cost_estimated: boolean;
  duration_ms: number;
  model: string;
  transport: Transport['name'];
}

export async function investigate(deps: RunDeps): Promise<RunResult> {
  const limits = { ...AGENT_LIMITS, ...deps.limits };
  const started = Date.now();
  const state: RunState = { calc: new Map() };
  const toolCalls: ToolCallRecord[] = [];
  const { transport, audit } = deps;
  let budgetUsed = 0;
  let planRejections = 0;
  let accepted: Plan | null = null;
  let gaveUp: string | null = null;

  const json = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  const call = async (name: string, input: unknown): Promise<ToolReply> => {
    if (accepted || gaveUp) return { text: 'This run is over. Stop here.', isError: true, stop: true };

    if (name === 'submit_plan') {
      const parsed = PlanSchema.safeParse(input);
      const problems = parsed.success
        ? checkPlan(parsed.data, { db: deps.db, issue: deps.issue, runCalc: state.calc, duplicateCopies: deps.duplicateCopies })
        : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      toolCalls.push({ name, input, ...(problems.length ? { error: problems.join('\n') } : { output: 'accepted' }) });
      audit.write({ kind: problems.length ? 'plan_rejected' : 'plan_accepted', input, problems });
      if (problems.length === 0) {
        accepted = parsed.data!;
        return { text: 'Plan accepted. It will be shown to a person for approval. Stop here; no reply is needed.', isError: false, stop: true };
      }
      if (++planRejections > limits.extraPlanAttempts) {
        gaveUp = `plan rejected ${planRejections} times`;
        return { text: json({ problems, note: 'Too many rejected plans; this run is over.' }), isError: true, stop: true };
      }
      return { text: json({ problems }), isError: true };
    }

    if (!(name in TOOL_INPUTS)) {
      toolCalls.push({ name, input, error: 'unknown tool' });
      return { text: `Unknown tool ${name}.`, isError: true };
    }
    if (budgetUsed >= limits.maxToolCalls) {
      toolCalls.push({ name, input, error: 'tool budget exhausted' });
      audit.write({ kind: 'tool_refused', name, reason: 'budget' });
      return { text: `Tool budget of ${limits.maxToolCalls} calls is used up. Submit your plan now.`, isError: true };
    }
    budgetUsed++;
    try {
      const output = executeTool(deps.db, state, name as Exclude<ToolName, 'submit_plan'>, input);
      toolCalls.push({ name, input, output });
      audit.write({ kind: 'tool_call', name, input, output });
      return { text: json(output), isError: false };
    } catch (err) {
      const message = err instanceof ToolError ? err.message : `Invalid input: ${(err as Error).message}`;
      toolCalls.push({ name, input, error: message });
      audit.write({ kind: 'tool_error', name, input, error: message });
      return { text: message, isError: true };
    }
  };

  audit.write({ kind: 'run_start', issue_id: deps.issue.issue_id, transport: transport.name, model: transport.model });
  const t = await transport.run({
    system: SYSTEM_PROMPT,
    user: issueBrief(deps.issue),
    tools: TOOL_SPECS,
    call,
    deadline: started + limits.deadlineMs,
    maxTurns: limits.maxToolCalls + limits.extraPlanAttempts + 4,
    onTurn: (content) => audit.write({ kind: 'model_turn', content }),
  });

  const plan = accepted as Plan | null;
  const failure = plan ? null : (gaveUp ?? (t.ended === 'stopped' ? 'stopped without a plan' : `${FAILURE_TEXT[t.ended]}${t.detail ? `: ${t.detail}` : ''}`));
  const status = plan ? 'planned' : 'failed';
  audit.write({ kind: 'run_end', status, failure, ended: t.ended, tool_calls: toolCalls.length, usage: t.usage });
  return { status, plan, failure, tool_calls: toolCalls, usage: t.usage, cost_usd: t.cost_usd, cost_estimated: t.cost_estimated, duration_ms: Date.now() - started, model: transport.model, transport: transport.name };
}
