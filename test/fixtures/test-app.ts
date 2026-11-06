import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAudit } from '../../src/agent/audit';
import { investigate } from '../../src/agent/loop';
import { saveRecording } from '../../src/agent/replay';
import { App, type AppOptions } from '../../src/app';
import { detectIssues } from '../../src/detect/index';
import { extractAll } from '../../src/extract/extract';
import { buildFacts, loadInbox } from '../../src/ingest/build';
import { rawFixtureExtractions } from './extractions';
import { scriptedAgent } from './scripted-agent';

/**
 * A complete app in a temp directory: fixture extractions as the cache, and recordings
 * made by the scripted test agent. Nothing touches the repo's cache/ or recorded/.
 */
export async function testApp(over: Partial<AppOptions> = {}): Promise<App> {
  const dir = mkdtempSync(join(tmpdir(), 'apx-app-'));
  const opts: AppOptions = { dataDir: 'data', cachePath: join(dir, 'extractions.json'), recordedDir: join(dir, 'recorded'), localDir: dir, workPath: join(dir, 'work.db'), model: 'claude-sonnet-5-5', effort: 'medium', ...over };
  const raw = rawFixtureExtractions();
  const { extractions } = await extractAll(loadInbox(opts.dataDir), opts.cachePath, { model: 'fixture', extract: async (e) => raw.get(e.emailId)! });
  const facts = await buildFacts(opts.dataDir, extractions, opts.overlaySql ? { overlaySql: opts.overlaySql } : {});
  const issues = detectIssues(facts.db);
  const dups = new Set(issues.filter((i) => i.type === 'duplicate_invoice').flatMap((i) => i.invoice_ids));
  for (const issue of issues) {
    const deps = { api: scriptedAgent(), db: facts.db, issue, duplicateInvoices: dups, model: opts.model, effort: opts.effort, audit: memoryAudit() };
    saveRecording(opts.recordedDir, issue.issue_id, deps, facts.digest, await investigate(deps));
  }
  return App.boot(opts);
}
