import { join } from 'node:path';
import type { Action } from '../src/actions/schema';
import { memoryAudit } from '../src/agent/audit';
import { investigate, type RunResult } from '../src/agent/loop';
import { loadRecording, madeWithEarlierPrompt, replayRun, saveRecording } from '../src/agent/replay';
import { detectIssues, duplicateCopies } from '../src/detect/index';
import type { Issue } from '../src/detect/types';
import { extractAll, transportExtractor } from '../src/extract/extract';
import type { VerifiedExtraction } from '../src/extract/schema';
import { buildFacts, loadInbox, type Facts } from '../src/ingest/build';
import type { Effort, Transport } from '../src/llm/transport';
import { approveAction, type ApprovalDeps } from '../src/work/approvals';
import { mintCapability } from '../src/work/capability';
import { WorkStore } from '../src/work/store';
import { CASES, type EvalCase } from './cases';
import { gradeDetection, gradePlan, targetIssue, type Grade } from './grade';

// Two passes. `recordCases` runs the agent live on chosen cases and saves each run.
// `runEvals` grades every case from the recordings: build facts (plus overlay), detect,
// replay the decision with current code, then push every proposed action through the real
// approval path: forged, wrong-hash and stale approvals must be refused, the genuine one
// must reach the outbox exactly once, and a second approval must be refused.

export interface EvalOptions {
  dataDir: string;
  cachePath: string;
  recordedDir: string;
  cases?: EvalCase[];
}

export interface CaseResult {
  id: string;
  tests: string;
  pass: boolean;
  detection: Grade;
  decision: Grade | null;
  guardrails: Grade | null;
  outcome: string | null;
  actions: string[];
  model: string | null;
  transport: string | null;
  tool_calls: number | null;
  cost_usd: number | null;
  cost_estimated: boolean;
  duration_ms: number | null;
  earlier_prompt: boolean;
}

export interface EvalReport {
  extraction_missing: string[];
  results: CaseResult[];
}

const recordingDir = (o: EvalOptions, c: EvalCase) => (c.overlay ? join(o.recordedDir, 'overlays', c.id) : o.recordedDir);

async function world(o: EvalOptions, extractions: Map<string, VerifiedExtraction>, c: EvalCase): Promise<{ facts: Facts; issues: Issue[] }> {
  const facts = await buildFacts(o.dataDir, extractions, c.overlay ? { overlaySql: c.overlay.sql } : {});
  return { facts, issues: detectIssues(facts.db) };
}

export interface Recorded {
  id: string;
  status: RunResult['status'] | 'skipped';
  detail: string | null;
  file?: string; // the recording written for this case
}

/** Live pass: fills missing extractions, then runs and records the agent on each chosen case. */
export async function recordCases(o: EvalOptions, live: { agent: Transport; extraction: Transport }, effort: Effort, onDone?: (r: Recorded) => void): Promise<Recorded[]> {
  const { extractions } = await extractAll(loadInbox(o.dataDir), o.cachePath, transportExtractor(live.extraction));
  const out: Recorded[] = [];
  for (const c of o.cases ?? CASES) {
    const { facts, issues } = await world(o, extractions, c);
    const issue = c.expect.detected ? targetIssue(c, issues) : undefined;
    let r: Recorded;
    if (!issue) {
      r = { id: c.id, status: 'skipped', detail: c.expect.detected ? 'expected issue was not detected' : 'detection-only case' };
    } else {
      const result = await investigate({ transport: live.agent, db: facts.db, issue, duplicateCopies: duplicateCopies(issues), audit: memoryAudit() });
      saveRecording(recordingDir(o, c), issue.issue_id, effort, facts.digest, result);
      r = { id: c.id, status: result.status, detail: result.failure, file: join(recordingDir(o, c), `${issue.issue_id}.json`) };
    }
    out.push(r);
    onDone?.(r);
  }
  return out;
}

/** SQL that makes an action stale: the invoice gets paid, or the vendor's phone on file changes. */
function staleOverlay(a: Action): string {
  if (a.type === 'verify_bank_change') return `UPDATE vendors SET contact_phone = '(415) 555-0100' WHERE vendor_id = '${a.vendor_id}'`;
  return `INSERT INTO payments VALUES ('PAY-STALE', '${a.invoice_id}', 1, '2026-03-15', 'eval', 'overlay'); UPDATE invoices SET status = 'paid' WHERE invoice_id = '${a.invoice_id}'`;
}

async function guardrails(o: EvalOptions, extractions: Map<string, VerifiedExtraction>, overlay: string | undefined, facts: Facts, issues: Issue[], issueId: string, result: RunResult): Promise<Grade> {
  const reasons: string[] = [];
  const store = await WorkStore.open(null);
  store.syncIssues(issues);
  const { runId } = store.saveRun(issueId, 'replay', result);
  const deps: ApprovalDeps = { store, facts: facts.db, duplicateCopies: () => duplicateCopies(issues) };
  const human = mintCapability('eval-reviewer');
  const outboxRows = () => store.db.all('SELECT 1 FROM outbox').length;

  for (const row of store.actions({ planId: runId })) {
    const id = row.action_id;
    const action = JSON.parse(row.payload_json) as Action;
    const expectRefused = (what: string, d: { ok: boolean }) => d.ok && reasons.push(`${id} (${row.type}): ${what} was approved`);

    expectRefused('a forged capability', approveAction({ sessionId: 'forged' }, deps, id, row.payload_hash));
    expectRefused('a different payload hash', approveAction(human, deps, id, 'f'.repeat(64)));
    const stale = await buildFacts(o.dataDir, extractions, { overlaySql: [overlay, staleOverlay(action)].filter(Boolean).join(';\n') });
    expectRefused('a stale action', approveAction(human, { ...deps, facts: stale.db }, id, row.payload_hash));

    const before = outboxRows();
    const first = approveAction(human, deps, id, row.payload_hash);
    if (!first.ok) reasons.push(`${id} (${row.type}): genuine approval refused: ${first.refused} ${first.problems?.join(' ') ?? ''}`);
    else if (outboxRows() !== before + 1) reasons.push(`${id}: approval did not write exactly one outbox row`);
    expectRefused('a second approval', approveAction(human, deps, id, row.payload_hash));
    if (outboxRows() !== before + (first.ok ? 1 : 0)) reasons.push(`${id}: outbox changed after a refused approval`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** Replay pass: grades every case from its recording, with no model calls. */
export async function runEvals(o: EvalOptions): Promise<EvalReport> {
  const { extractions, missing } = await extractAll(loadInbox(o.dataDir), o.cachePath);
  const results: CaseResult[] = [];

  for (const c of o.cases ?? CASES) {
    const { facts, issues } = await world(o, extractions, c);
    const r: CaseResult = {
      id: c.id, tests: c.tests, pass: false, detection: gradeDetection(c, issues), decision: null, guardrails: null,
      outcome: null, actions: [], model: null, transport: null, tool_calls: null, cost_usd: null, cost_estimated: false, duration_ms: null, earlier_prompt: false,
    };
    const issue = c.expect.detected ? targetIssue(c, issues) : undefined;

    if (issue) {
      const rec = loadRecording(recordingDir(o, c), issue.issue_id);
      if (!rec) {
        r.decision = { pass: false, reasons: [`no recording for ${issue.issue_id} in ${recordingDir(o, c)}; record it with \`npm run eval -- --case ${c.id}\``] };
      } else {
        const run = await replayRun(rec, { db: facts.db, issue, duplicateCopies: duplicateCopies(issues), audit: memoryAudit() });
        r.decision = gradePlan(c, run.plan, run.failure);
        r.outcome = run.plan?.outcome ?? 'run failed';
        r.actions = run.plan?.actions.map((a) => a.type) ?? [];
        Object.assign(r, { model: rec.model, transport: rec.transport, tool_calls: rec.tool_calls.length, cost_usd: rec.cost_usd, cost_estimated: rec.cost_estimated, duration_ms: rec.duration_ms, earlier_prompt: madeWithEarlierPrompt(rec) });
        if (run.plan) r.guardrails = await guardrails(o, extractions, c.overlay?.sql, facts, issues, issue.issue_id, run);
      }
    }
    r.pass = r.detection.pass && (r.decision?.pass ?? !c.expect.detected) && (r.guardrails?.pass ?? true);
    results.push(r);
  }
  return { extraction_missing: missing, results };
}
