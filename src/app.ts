import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { AGENT_LIMITS, PATHS } from './config';
import { fileAudit, memoryAudit } from './agent/audit';
import { investigate, type Effort } from './agent/loop';
import { loadRecording, replayRun, saveRecording } from './agent/replay';
import { detectIssues } from './detect/index';
import type { Issue } from './detect/types';
import { claudeExtractor, extractAll } from './extract/extract';
import { buildFacts, loadInbox, type Facts } from './ingest/build';
import { WorkStore } from './work/store';

// Boot order: build facts (with cached or live email extraction), detect and rank issues,
// replay recorded runs with current code, then (only with an API key) investigate the rest live.

export interface AppOptions {
  dataDir: string;
  cachePath: string;
  recordedDir: string;
  localDir: string;
  workPath: string | null;
  apiKey?: string | undefined;
  model: string;
  effort: Effort;
  overlaySql?: string;
}

export function defaultOptions(env: { apiKey?: string | undefined; model: string; effort: Effort }): AppOptions {
  return { dataDir: PATHS.data, cachePath: PATHS.cache, recordedDir: PATHS.recorded, localDir: PATHS.local, workPath: join(PATHS.local, 'work.db'), ...env };
}

export class App {
  readonly investigating = new Set<string>();

  private constructor(
    readonly opts: AppOptions,
    readonly facts: Facts,
    readonly issues: Issue[],
    readonly store: WorkStore,
    readonly extractionMissing: string[],
    private readonly client: Anthropic | null,
  ) {}

  get mode(): 'live' | 'replay' {
    return this.client ? 'live' : 'replay';
  }

  static async boot(opts: AppOptions): Promise<App> {
    const client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : null;
    const extractor = client ? claudeExtractor(client, opts.model, 'low') : undefined;
    const { extractions, missing } = await extractAll(loadInbox(opts.dataDir), opts.cachePath, extractor);
    const facts = await buildFacts(opts.dataDir, extractions, opts.overlaySql ? { overlaySql: opts.overlaySql } : {});
    mkdirSync(opts.localDir, { recursive: true });
    writeFileSync(join(opts.localDir, 'facts.db'), facts.db.export()); // for readers who want to poke at it

    const issues = detectIssues(facts.db);
    const store = await WorkStore.open(opts.workPath);
    store.syncIssues(issues);
    store.log('system', 'boot', { facts_digest: facts.digest, issues: issues.length, mode: client ? 'live' : 'replay', extraction_missing: missing });
    const app = new App(opts, facts, issues, store, missing, client);
    await app.replayRecorded();
    return app;
  }

  duplicateInvoices(): Set<string> {
    return new Set(this.issues.filter((i) => i.type === 'duplicate_invoice').flatMap((i) => i.invoice_ids));
  }

  issue(issueId: string): Issue | undefined {
    return this.issues.find((i) => i.issue_id === issueId);
  }

  /** Every issue with a recording is re-run through current code. */
  async replayRecorded(): Promise<void> {
    for (const issue of this.issues) {
      const rec = loadRecording(this.opts.recordedDir, issue.issue_id);
      if (!rec) continue;
      const result = await replayRun(rec, { db: this.facts.db, issue, duplicateInvoices: this.duplicateInvoices(), audit: memoryAudit() });
      this.store.saveRun(issue.issue_id, 'replay', result);
    }
  }

  /** Issues with no recording yet. In live mode these are investigated in the background. */
  unrecorded(): Issue[] {
    return this.issues.filter((i) => !loadRecording(this.opts.recordedDir, i.issue_id));
  }

  /** Investigates issues live, a few at a time, recording each run for replay. */
  async investigateLive(issues: Issue[], concurrency = AGENT_LIMITS.concurrency): Promise<void> {
    const client = this.client;
    if (!client) return;
    const queue = [...issues];
    const worker = async () => {
      for (let issue = queue.shift(); issue; issue = queue.shift()) {
        this.investigating.add(issue.issue_id);
        try {
          const runId = `${issue.issue_id}.${new Date().toISOString().replace(/[:.]/g, '-')}`;
          const deps = { api: client.messages, db: this.facts.db, issue, duplicateInvoices: this.duplicateInvoices(), model: this.opts.model, effort: this.opts.effort, audit: fileAudit(this.opts.localDir, runId) };
          const result = await investigate(deps);
          saveRecording(this.opts.recordedDir, issue.issue_id, deps, this.facts.digest, result);
          this.store.saveRun(issue.issue_id, 'live', result);
        } catch (err) {
          this.store.log('copilot', 'run_error', { issue_id: issue.issue_id, message: (err as Error).message });
        } finally {
          this.investigating.delete(issue.issue_id);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }
}
