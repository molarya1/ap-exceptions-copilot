import { writeFileSync } from 'node:fs';
import { env, PATHS } from '../src/config';
import { extractAll, transportExtractor } from '../src/extract/extract';
import { loadInbox } from '../src/ingest/build';
import { liveTransport } from '../src/llm/live';
import { CASES } from './cases';
import { recordCases, runEvals, type EvalOptions } from './harness';
import { loadVariance, repeatCases, saveVariance, VARIANCE_PATH } from './repeat';
import { renderReport } from './report';

// npm run eval:replay                 grade every case from the recordings (no model calls)
// npm run extract                     live: fill the email extraction cache only
// npm run eval [-- --case <id> ...]   live: record the chosen cases (default all), then grade all
// npm run eval -- --repeat N [--keep-if-all-pass] [--case <id> ...]
//                                     live: run each decision case N times without touching the
//                                     committed recordings; write pass rates to evals/variance.json
//
// Live runs go through the logged-in Claude Code CLI (LIVE_VIA_CLAUDE_CODE=1). The Messages
// API path bills an API key, so it also needs --allow-api-billing.

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const mode = flag('--extract') ? 'extract' : flag('--live') ? 'live' : 'replay';
const chosen = args.flatMap((a, i) => (args[i - 1] === '--case' ? [a] : []));
const repeatArg = args[args.indexOf('--repeat') + 1];
const repeat = args.includes('--repeat') ? Number(repeatArg) : 0;
if (args.includes('--repeat') && (mode !== 'live' || !Number.isInteger(repeat) || repeat < 1)) fail('--repeat N needs a whole number N >= 1 and live mode (npm run eval).');
const unknown = chosen.filter((id) => !CASES.some((c) => c.id === id));
if (unknown.length) {
  console.error(`Unknown case(s): ${unknown.join(', ')}. Cases: ${CASES.map((c) => c.id).join(', ')}`);
  process.exit(2);
}

const opts: EvalOptions = { dataDir: PATHS.data, cachePath: PATHS.cache, recordedDir: PATHS.recorded };

if (mode !== 'replay') {
  const e = env();
  if (!e.liveVia) fail('Live runs need LIVE_VIA_CLAUDE_CODE=1 (uses your Claude Code login). Use npm run eval:replay to grade recordings without a model.');
  if (e.liveVia === 'messages-api' && !flag('--allow-api-billing')) fail('Only ANTHROPIC_API_KEY is set, which bills the API. Set LIVE_VIA_CLAUDE_CODE=1, or pass --allow-api-billing to use the key on purpose.');
  const agent = liveTransport(e.liveVia, e.model, e.effort, e.apiKey)!;
  const extraction = liveTransport(e.liveVia, e.model, 'low', e.apiKey)!;
  console.log(`live via ${agent.name}, model ${e.model}, effort ${e.effort}`);

  if (mode === 'extract') {
    const emails = loadInbox(opts.dataDir);
    const { missing } = await extractAll(emails, opts.cachePath, transportExtractor(extraction));
    console.log(`${emails.length - missing.length}/${emails.length} emails extracted · ${opts.cachePath}`);
    process.exit(0);
  }
  const cases = chosen.length ? CASES.filter((c) => chosen.includes(c.id)) : CASES;
  if (repeat) {
    const v = await repeatCases({ ...opts, cases }, { agent, extraction }, e.effort, repeat, flag('--keep-if-all-pass'), (i, id, pass, outcome) => console.log(`run ${i}  ${pass ? 'pass' : 'FAIL'}  ${id} (${outcome})`));
    saveVariance(v);
    console.log('');
    for (const c of v.cases) console.log(`${c.passes}/${c.runs}  ${c.id}${c.kept ? '  (last run kept as the recording)' : ''}`);
    console.log(`\n${VARIANCE_PATH} written\n`);
  } else await recordCases({ ...opts, cases }, { agent, extraction }, e.effort, (r) => console.log(`recorded  ${r.id}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`));
  console.log('');
}

const report = await runEvals(opts);
writeFileSync('evals/results.md', renderReport(report, loadVariance()));
for (const r of report.results) {
  const why = [...r.detection.reasons, ...(r.decision?.reasons ?? []), ...(r.guardrails?.reasons ?? [])];
  console.log(`${r.pass ? 'pass' : 'FAIL'}  ${r.id}${why.length ? `\n      ${why.join('\n      ')}` : ''}`);
}
const failed = report.results.filter((r) => !r.pass).length;
console.log(`\n${report.results.length - failed}/${report.results.length} cases pass · evals/results.md written`);
process.exit(failed ? 1 : 0);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
