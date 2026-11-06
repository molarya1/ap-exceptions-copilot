import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Action } from '../actions/schema';
import type { RunResult } from '../agent/loop';
import type { Plan } from '../agent/plan';
import type { Issue } from '../detect/types';
import { hashJson } from '../lib/hash';
import type { Db } from '../lib/sqlite';
import { openDb } from '../lib/sqlite';

// work.db: runs, plans, actions, approvals, claims, outbox and the activity log.
// Persists across restarts. Every write goes through tx(), which commits and saves.

const SCHEMA_VERSION = 2;
const WORK_SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (issue_id TEXT PRIMARY KEY, type TEXT NOT NULL, json TEXT NOT NULL, active INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, failure TEXT,
  model TEXT NOT NULL, transport TEXT NOT NULL, started_at TEXT NOT NULL, duration_ms INTEGER, tool_calls INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL, cost_estimated INTEGER NOT NULL,
  trail_json TEXT NOT NULL, result_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (plan_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, issue_id TEXT NOT NULL, plan_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS actions (
  action_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, issue_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
  payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'superseded'))
);
CREATE TABLE IF NOT EXISTS approvals (
  approval_id INTEGER PRIMARY KEY, action_id TEXT NOT NULL, decision TEXT NOT NULL, payload_hash TEXT NOT NULL,
  session_id TEXT NOT NULL, reason TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (claim_key TEXT PRIMARY KEY, action_id TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (outbox_id INTEGER PRIMARY KEY, action_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, document_json TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity (activity_id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL);
`;

export interface ActionRow {
  action_id: string;
  plan_id: string;
  issue_id: string;
  seq: number;
  type: Action['type'];
  payload_json: string;
  payload_hash: string;
  status: 'proposed' | 'approved' | 'rejected' | 'superseded';
}

export interface RunRow {
  run_id: string;
  issue_id: string;
  mode: 'live' | 'replay';
  status: 'planned' | 'failed';
  failure: string | null;
  model: string;
  transport: string;
  started_at: string;
  duration_ms: number;
  tool_calls: number;
  cost_usd: number | null;
  cost_estimated: number;
  trail_json: string;
  result_hash: string;
}

export const payloadHash = (a: Action) => hashJson(a);
const now = () => new Date().toISOString();

export class WorkStore {
  private constructor(
    readonly db: Db,
    private readonly path: string | null,
  ) {}

  /** Opens work.db from disk (or in memory when path is null, for tests). */
  static async open(path: string | null): Promise<WorkStore> {
    const bytes = path && existsSync(path) ? readFileSync(path) : undefined;
    let db = await openDb(bytes);
    // work.db is local demo state: one written by an older schema is set aside, not migrated.
    if (bytes && db.get<{ user_version: number }>('PRAGMA user_version')!.user_version !== SCHEMA_VERSION) {
      db.close();
      renameSync(path!, `${path}.old`);
      db = await openDb();
    }
    db.exec(WORK_SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return new WorkStore(db, path);
  }

  /** One transaction; on commit, the file on disk is replaced atomically. */
  tx<T>(fn: () => T): T {
    const out = this.db.transaction(fn);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.tmp`, this.db.export());
      renameSync(`${this.path}.tmp`, this.path);
    }
    return out;
  }

  log(actor: string, event: string, detail: unknown): void {
    this.tx(() => this.logInTx(actor, event, detail));
  }

  logInTx(actor: string, event: string, detail: unknown): void {
    this.db.run('INSERT INTO activity (at, actor, event, detail) VALUES (?, ?, ?, ?)', [now(), actor, event, typeof detail === 'string' ? detail : JSON.stringify(detail)]);
  }

  /** Current detector output. Issues no longer detected stay, marked inactive. */
  syncIssues(issues: Issue[]): void {
    this.tx(() => {
      this.db.run('UPDATE issues SET active = 0');
      for (const i of issues) this.db.run('INSERT INTO issues (issue_id, type, json, active) VALUES (?, ?, ?, 1) ON CONFLICT (issue_id) DO UPDATE SET json = excluded.json, active = 1', [i.issue_id, i.type, JSON.stringify(i)]);
    });
  }

  latestRun(issueId: string): RunRow | undefined {
    return this.db.get<RunRow>('SELECT * FROM runs WHERE issue_id = ? ORDER BY rowid DESC LIMIT 1', [issueId]);
  }

  /**
   * Stores a finished run. If it matches the latest stored run for the issue (same plan, same
   * status, same tool results), nothing is written, so approvals on that plan stay valid.
   * Otherwise pending actions of older plans are superseded.
   */
  saveRun(issueId: string, mode: RunRow['mode'], result: RunResult): { runId: string; changed: boolean } {
    const trail = result.tool_calls;
    const resultHash = hashJson({ status: result.status, failure: result.failure, plan: result.plan, trail });
    const latest = this.latestRun(issueId);
    if (latest && latest.result_hash === resultHash) return { runId: latest.run_id, changed: false };

    return this.tx(() => {
      const n = (this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE issue_id = ?', [issueId])?.n ?? 0) + 1;
      const runId = `${issueId}.r${n}`;
      const u = result.usage;
      this.db.run(
        `INSERT INTO runs (run_id, issue_id, mode, status, failure, model, transport, started_at, duration_ms, tool_calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_estimated, trail_json, result_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [runId, issueId, mode, result.status, result.failure, result.model, result.transport, now(), result.duration_ms, trail.length, u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, result.cost_usd, result.cost_estimated ? 1 : 0, JSON.stringify(trail), resultHash],
      );
      this.db.run("UPDATE actions SET status = 'superseded' WHERE issue_id = ? AND status = 'proposed'", [issueId]);
      if (result.plan) this.savePlan(runId, issueId, result.plan);
      this.logInTx('copilot', `run_${result.status}`, { run_id: runId, mode, failure: result.failure });
      return { runId, changed: true };
    });
  }

  private savePlan(runId: string, issueId: string, plan: Plan): void {
    this.db.run('INSERT INTO plans (plan_id, run_id, issue_id, plan_json) VALUES (?, ?, ?, ?)', [runId, runId, issueId, JSON.stringify(plan)]);
    plan.actions.forEach((a, i) => {
      this.db.run("INSERT INTO actions (action_id, plan_id, issue_id, seq, type, payload_json, payload_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed')", [
        `${runId}.a${i + 1}`, runId, issueId, i + 1, a.type, JSON.stringify(a), payloadHash(a),
      ]);
    });
  }

  plan(runId: string): Plan | null {
    const row = this.db.get<{ plan_json: string }>('SELECT plan_json FROM plans WHERE run_id = ?', [runId]);
    return row ? (JSON.parse(row.plan_json) as Plan) : null;
  }

  actions(where: { planId?: string; status?: ActionRow['status'] } = {}): ActionRow[] {
    if (where.planId) return this.db.all<ActionRow>('SELECT * FROM actions WHERE plan_id = ? ORDER BY seq', [where.planId]);
    if (where.status) return this.db.all<ActionRow>('SELECT * FROM actions WHERE status = ? ORDER BY issue_id, seq', [where.status]);
    return this.db.all<ActionRow>('SELECT * FROM actions ORDER BY issue_id, seq');
  }

  action(actionId: string): ActionRow | undefined {
    return this.db.get<ActionRow>('SELECT * FROM actions WHERE action_id = ?', [actionId]);
  }
}
