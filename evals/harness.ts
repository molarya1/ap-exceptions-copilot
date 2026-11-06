import { join } from 'node:path';
import type { Action } from '../src/actions/schema';
import { memoryAudit } from '../src/agent/audit';
import { investigate, type Effort, type MessagesApi, type RunResult } from '../src/agent/loop';
import { loadRecording, replayRun, saveRecording } from '../src/agent/replay';
import { detectIssues } from '../src/detect/index';
import type { Issue } from '../src/detect/types';
import { extractAll, type ExtractionModel } from '../src/extract/extract';
import type { VerifiedExtraction } from '../src/extract/schema';
import { buildFacts, loadInbox, type Facts } from '../src/ingest/build';
import { approveAction, type ApprovalDeps } from '../src/work/approvals';
import { mintCapability } from '../src/work/capability';
import { WorkStore } from '../src/work/store';
import { CASES, type EvalCase } from './cases';
import { gradeDetection, gradePlan, targetIssue, type Grade } from './grade';

// Runs every case: build facts (plus overlay), detect, then decide the case's issue either
// live (recording the run) or from a recording. Every proposed action then goes through the
// real approval path: forged, wrong-hash and stale approvals must be refused, the genuine
// one must reach the outbox exactly once, and a second approval must be refused.

export interface EvalOptions {
  mode: 'live' | 'replay';
  dataDir: string;
  cachePath: string;
  recordedDir: string;
  model: string;
  effort: Effort;
  api?: MessagesApi; // live mode only
  extractor?: ExtractionModel; // live mode only: fills the extraction cache
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
  tool_calls: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
}

export interface EvalReport {
  mode: 'live' | 'replay';
  model: string;
  extraction_missing: string[];
  results: CaseResult[];
}

const recordingDir = (o: EvalOptions, c: EvalCase) => (c.overlay ? join(o.recordedDir, 'overlays', c.id) : o.recordedDir);
const dupSet = (issues: Issue[]) => new Set(issues.filter((i) => i.type === 'duplicate_invoice').flatMap((i) => i.invoice_ids));

async function decide(o: EvalOptions, c: EvalCase, facts: Facts, issues: Issue[], issue: Issue): Promise<RunResult | string> {
  const deps = { db: facts.db, issue, duplicateInvoices: dupSet(issues), audit: memoryAudit() };
  if (o.mode === 'live') {
    const live = { ...deps, api: o.api!, model: o.model, effort: o.effort };
    const result = await investigate(live);
    saveRecording(recordingDir(o, c), issue.issue_id, live, facts.digest, result);
    return result;
  }
  const rec = loadRecording(recordingDir(o, c), issue.issue_id);
  if (!rec) return `no recording for ${issue.issue_id} in ${recordingDir(o, c)}; run \`npm run eval\` with ANTHROPIC_API_KEY set to record one`;
  return replayRun(rec, deps);
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
  const deps: ApprovalDeps = { store, facts: facts.db, duplicateInvoices: () => dupSet(issues) };
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

export async function runEvals(o: EvalOptions): Promise<EvalReport> {
  const { extractions, missing } = await extractAll(loadInbox(o.dataDir), o.cachePath, o.mode === 'live' ? o.extractor : undefined);
  const results: CaseResult[] = [];

  for (const c of o.cases ?? CASES) {
    const facts = await buildFacts(o.dataDir, extractions, c.overlay ? { overlaySql: c.overlay.sql } : {});
    const issues = detectIssues(facts.db);
    const r: CaseResult = { id: c.id, tests: c.tests, pass: false, detection: gradeDetection(c, issues), decision: null, guardrails: null, outcome: null, actions: [], tool_calls: null, cost_usd: null, duration_ms: null };
    const issue = c.expect.detected ? targetIssue(c, issues) : undefined;

    if (issue) {
      const run = await decide(o, c, facts, issues, issue);
      if (typeof run === 'string') {
        r.decision = { pass: false, reasons: [run] };
      } else {
        r.decision = gradePlan(c, run.plan, run.failure);
        r.outcome = run.plan?.outcome ?? 'run failed';
        r.actions = run.plan?.actions.map((a) => a.type) ?? [];
        r.tool_calls = run.tool_calls.length;
        r.cost_usd = run.cost_usd;
        r.duration_ms = run.duration_ms;
        if (run.plan) r.guardrails = await guardrails(o, extractions, c.overlay?.sql, facts, issues, issue.issue_id, run);
      }
    }
    r.pass = r.detection.pass && (r.decision?.pass ?? !c.expect.detected) && (r.guardrails?.pass ?? true);
    results.push(r);
  }
  return { mode: o.mode, model: o.model, extraction_missing: missing, results };
}
