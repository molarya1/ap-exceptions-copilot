import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// One JSON line per event: every model turn, tool input, tool output and refusal.

export interface Audit {
  write(event: Record<string, unknown>): void;
}

export function fileAudit(dir: string, runId: string): Audit {
  const runDir = join(dir, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, 'audit.jsonl');
  return { write: (event) => appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n') };
}

export function memoryAudit(): Audit & { events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  return { events, write: (event) => events.push(event) };
}
