import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAudit } from '../../src/agent/audit';
import { investigate } from '../../src/agent/loop';
import { saveRecording } from '../../src/agent/replay';
import { App, type AppOptions } from '../../src/app';
import { detectIssues, duplicateCopies } from '../../src/detect/index';
import { extractAll, transportExtractor } from '../../src/extract/extract';
import { buildFacts, loadInbox } from '../../src/ingest/build';
import { fixtureExtractionTransport, scriptedTransport } from './transports';

/**
 * A complete app in a temp directory: fixture extractions as the cache, and recordings
 * made by the scripted test agent. Nothing touches the repo's cache/ or recorded/.
 */
export async function testApp(over: Partial<AppOptions> = {}): Promise<App> {
  const dir = mkdtempSync(join(tmpdir(), 'apx-app-'));
  const opts: AppOptions = { dataDir: 'data', cachePath: join(dir, 'extractions.json'), recordedDir: join(dir, 'recorded'), localDir: dir, workPath: join(dir, 'work.db'), live: null, effort: 'medium', ...over };
  const { extractions } = await extractAll(loadInbox(opts.dataDir), opts.cachePath, transportExtractor(fixtureExtractionTransport()));
  const facts = await buildFacts(opts.dataDir, extractions, opts.overlaySql ? { overlaySql: opts.overlaySql } : {});
  const issues = detectIssues(facts.db);
  const dups = duplicateCopies(issues);
  for (const issue of issues) {
    const result = await investigate({ transport: scriptedTransport(), db: facts.db, issue, duplicateCopies: dups, audit: memoryAudit() });
    saveRecording(opts.recordedDir, issue.issue_id, opts.effort, facts.digest, result);
  }
  return App.boot(opts);
}
