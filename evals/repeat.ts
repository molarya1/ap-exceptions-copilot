import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { Effort, Transport } from '../src/llm/transport';
import { CASES } from './cases';
import { recordCases, runEvals, type EvalOptions } from './harness';

// Variance: run each decision case N times live and grade every attempt the same way replay
// does. Attempts are recorded in a temporary directory, so committed recordings are untouched,
// unless every attempt of a case passed and `keep` asks for the last one to replace it.

export interface CaseVariance {
  id: string;
  runs: number;
  passes: number;
  outcomes: Record<string, number>;
  failures: string[];
  kept: boolean;
}

export interface Variance {
  recorded_at: string;
  model: string;
  transport: string;
  effort: string;
  repeats: number;
  cases: CaseVariance[];
}

export const VARIANCE_PATH = 'evals/variance.json';

export async function repeatCases(o: EvalOptions, live: { agent: Transport; extraction: Transport }, effort: Effort, n: number, keep: boolean, onAttempt?: (i: number, id: string, pass: boolean, outcome: string) => void): Promise<Variance> {
  const cases = (o.cases ?? CASES).filter((c) => c.scenario && c.expect.detected);
  const tally = new Map<string, CaseVariance>(cases.map((c) => [c.id, { id: c.id, runs: 0, passes: 0, outcomes: {}, failures: [], kept: false }]));
  const lastFile = new Map<string, { dir: string; file: string }>();
  const dirs: string[] = [];

  try {
    for (let i = 1; i <= n; i++) {
      const dir = mkdtempSync(join(tmpdir(), 'apx-repeat-'));
      dirs.push(dir);
      const recorded = await recordCases({ ...o, cases, recordedDir: dir }, live, effort);
      const report = await runEvals({ ...o, cases, recordedDir: dir });
      for (const r of report.results) {
        const t = tally.get(r.id)!;
        const outcome = r.outcome ?? 'not run';
        t.runs++;
        t.outcomes[outcome] = (t.outcomes[outcome] ?? 0) + 1;
        if (r.pass) t.passes++;
        else t.failures.push(`run ${i}: ${[...r.detection.reasons, ...(r.decision?.reasons ?? []), ...(r.guardrails?.reasons ?? [])].join('; ')}`);
        const file = recorded.find((x) => x.id === r.id)?.file;
        if (file) lastFile.set(r.id, { dir, file });
        onAttempt?.(i, r.id, r.pass, outcome);
      }
    }
    if (keep) {
      for (const t of tally.values()) {
        const last = lastFile.get(t.id);
        if (t.passes !== t.runs || !last || !existsSync(last.file)) continue;
        const target = join(o.recordedDir, relative(last.dir, last.file));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(last.file, target);
        t.kept = true;
      }
    }
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
  return { recorded_at: new Date().toISOString(), model: live.agent.model, transport: live.agent.name, effort, repeats: n, cases: [...tally.values()] };
}

export function saveVariance(v: Variance, path = VARIANCE_PATH): void {
  writeFileSync(path, JSON.stringify(v, null, 2) + '\n');
}

export function loadVariance(path = VARIANCE_PATH): Variance | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Variance) : null;
}

/** "act ×2, hold_and_ask ×1", or just "act" when every run agreed. */
export function outcomeMix(outcomes: Record<string, number>): string {
  const entries = Object.entries(outcomes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length === 1 ? entries[0]![0] : entries.map(([k, v]) => `${k} ×${v}`).join(', ');
}
