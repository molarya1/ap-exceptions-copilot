import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { hashJson } from '../lib/hash';
import type { UsageTotals } from '../llm/cost';
import { investigate, type RunDeps, type RunResult, type ToolCallRecord } from './loop';
import { SYSTEM_PROMPT } from './prompt';
import { TOOL_SPECS } from './tools';
import type { Transport } from '../llm/transport';

// A recording is transport-neutral: the ordered tool calls the model made, the final plan,
// usage, cost, model and duration. Replay issues the same tool calls again through the
// normal loop, so tools, calculators and plan checks run with today's code on today's data;
// recorded outputs are kept only for reading. A recorded plan that today's checks reject
// makes the replayed run fail.

export interface Recording {
  format: 2;
  issue_id: string;
  recorded_at: string;
  transport: RunResult['transport'];
  model: string;
  effort: string;
  facts_digest: string;
  prompt_hash: string; // system prompt + tool definitions at record time
  status: RunResult['status'];
  failure: string | null;
  tool_calls: ToolCallRecord[];
  final_plan: unknown;
  usage: UsageTotals;
  cost_usd: number | null;
  cost_estimated: boolean;
  duration_ms: number;
}

export const promptHash = () => hashJson({ system: SYSTEM_PROMPT, tools: TOOL_SPECS.map((t) => ({ name: t.name, description: t.description, input: z.toJSONSchema(t.input) })) });
const fileFor = (dir: string, issueId: string) => join(dir, `${issueId}.json`);

export function saveRecording(dir: string, issueId: string, effort: string, factsDigest: string, result: RunResult): void {
  mkdirSync(dir, { recursive: true });
  const rec: Recording = {
    format: 2,
    issue_id: issueId,
    recorded_at: new Date().toISOString(),
    transport: result.transport,
    model: result.model,
    effort,
    facts_digest: factsDigest,
    prompt_hash: promptHash(),
    status: result.status,
    failure: result.failure,
    tool_calls: result.tool_calls,
    final_plan: result.plan,
    usage: result.usage,
    cost_usd: result.cost_usd,
    cost_estimated: result.cost_estimated,
    duration_ms: result.duration_ms,
  };
  writeFileSync(fileFor(dir, issueId), JSON.stringify(rec, null, 2) + '\n');
}

export function loadRecording(dir: string, issueId: string): Recording | null {
  const path = fileFor(dir, issueId);
  if (!existsSync(path)) return null;
  const rec = JSON.parse(readFileSync(path, 'utf8')) as Recording;
  return rec.format === 2 ? rec : null;
}

/**
 * True when the recording was made with a different system prompt or tool definitions.
 * Replay still runs it: only today's checks decide whether its plan stands.
 */
export const madeWithEarlierPrompt = (rec: Recording) => rec.prompt_hash !== promptHash();

const ENDED = 'the recording ended';

/** Plays the recorded tool calls, in order, into the loop's tool handler. */
export function replayTransport(rec: Recording): Transport {
  return {
    name: 'replay',
    model: rec.model,
    async run(c) {
      const done = (ended: 'stopped' | 'no_tool_call', detail: string | null) => ({ ended, detail, usage: rec.usage, cost_usd: rec.cost_usd, cost_estimated: rec.cost_estimated });
      for (const t of rec.tool_calls) if ((await c.call(t.name, t.input)).stop) return done('stopped', null);
      return done('no_tool_call', ENDED);
    },
  };
}

/** Re-runs a recording with current code. Cost and duration are the live run's. */
export async function replayRun(rec: Recording, deps: Omit<RunDeps, 'transport'>): Promise<RunResult> {
  const result = await investigate({ ...deps, transport: replayTransport(rec), limits: { ...deps.limits, deadlineMs: 86_400_000 } });
  let failure = result.failure;
  if (failure?.endsWith(ENDED)) {
    failure = rec.status === 'failed' ? `the live run failed: ${rec.failure}` : 'current checks do not accept the recorded run (the recording ends before a plan is accepted)';
  }
  return { ...result, failure, duration_ms: rec.duration_ms, transport: rec.transport };
}
