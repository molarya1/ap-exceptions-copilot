import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { hashJson } from '../lib/hash';
import { investigate, type MessagesApi, type RunDeps, type RunResult } from './loop';
import { SYSTEM_PROMPT } from './prompt';
import { TOOL_DEFS } from './tools';

// Replay: a live run's model responses are recorded. Replaying feeds them back through the
// same loop, so tools, calculators and plan checks all run again with today's code.
// If today's checks reject the recorded plan, the recording runs out and the run fails.

export interface Recording {
  issue_id: string;
  recorded_at: string;
  model: string;
  effort: string;
  facts_digest: string;
  prompt_hash: string; // system prompt + tool definitions at record time
  responses: Anthropic.Message[];
  live: { status: string; failure: string | null; tool_calls: number; cost_usd: number | null; duration_ms: number };
  final_plan: unknown;
}

export const promptHash = () => hashJson({ system: SYSTEM_PROMPT, tools: TOOL_DEFS });
const fileFor = (dir: string, issueId: string) => join(dir, `${issueId}.json`);

export function saveRecording(dir: string, issueId: string, deps: Pick<RunDeps, 'model' | 'effort'>, factsDigest: string, result: RunResult): void {
  mkdirSync(dir, { recursive: true });
  const rec: Recording = {
    issue_id: issueId,
    recorded_at: new Date().toISOString(),
    model: deps.model,
    effort: deps.effort,
    facts_digest: factsDigest,
    prompt_hash: promptHash(),
    responses: result.responses,
    live: { status: result.status, failure: result.failure, tool_calls: result.tool_calls.length, cost_usd: result.cost_usd, duration_ms: result.duration_ms },
    final_plan: result.plan,
  };
  writeFileSync(fileFor(dir, issueId), JSON.stringify(rec, null, 2) + '\n');
}

export function loadRecording(dir: string, issueId: string): Recording | null {
  const path = fileFor(dir, issueId);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Recording) : null;
}

export class RecordingEnded extends Error {}

export function replayApi(rec: Recording): MessagesApi {
  let i = 0;
  return {
    async create() {
      const next = rec.responses[i++];
      if (!next) throw new RecordingEnded('the recording ended before the run finished');
      return structuredClone(next);
    },
  };
}

/** Re-runs a recording with current code. Cost and duration are the live run's. */
export async function replayRun(rec: Recording, deps: Omit<RunDeps, 'api' | 'model' | 'effort'>): Promise<RunResult> {
  const result = await investigate({ ...deps, api: replayApi(rec), model: rec.model, effort: rec.effort as RunDeps['effort'], limits: { ...deps.limits, deadlineMs: 86_400_000 } });
  const failure =
    result.status === 'failed' && result.failure?.includes('recording ended')
      ? 'current checks do not accept the recorded run (the recording ends before a plan is accepted)'
      : result.failure;
  return { ...result, failure, cost_usd: rec.live.cost_usd, duration_ms: rec.live.duration_ms };
}
