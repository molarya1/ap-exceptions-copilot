import { writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { env, PATHS } from '../src/config';
import { claudeExtractor } from '../src/extract/extract';
import { runEvals } from './harness';
import { renderReport } from './report';

// npm run eval         live: extracts missing emails, runs the agent on every case, records the runs
// npm run eval:replay  no key: replays the recordings with current code and grades them

const mode = process.argv.includes('--live') ? 'live' : 'replay';
const e = env();
if (mode === 'live' && !e.apiKey) {
  console.error('npm run eval makes paid API calls and needs ANTHROPIC_API_KEY. Use npm run eval:replay to grade the recordings without a key.');
  process.exit(2);
}
const client = mode === 'live' ? new Anthropic({ apiKey: e.apiKey }) : null;

const report = await runEvals({
  mode,
  dataDir: PATHS.data,
  cachePath: PATHS.cache,
  recordedDir: PATHS.recorded,
  model: e.model,
  effort: e.effort,
  ...(client ? { api: client.messages, extractor: claudeExtractor(client, e.model, 'low') } : {}),
});

writeFileSync('evals/results.md', renderReport(report));
for (const r of report.results) {
  const why = [...r.detection.reasons, ...(r.decision?.reasons ?? []), ...(r.guardrails?.reasons ?? [])];
  console.log(`${r.pass ? 'pass' : 'FAIL'}  ${r.id}${why.length ? `\n      ${why.join('\n      ')}` : ''}`);
}
const failed = report.results.filter((r) => !r.pass).length;
console.log(`\n${report.results.length - failed}/${report.results.length} cases pass · evals/results.md written`);
process.exit(failed ? 1 : 0);
