import type { Action } from '../src/actions/schema';
import type { Plan } from '../src/agent/plan';
import type { Issue } from '../src/detect/types';
import type { ActionMatcher, EvalCase } from './cases';
import { scenario, truth } from './cases';

// Deterministic grading. No model judges another model here.

export interface Grade {
  pass: boolean;
  reasons: string[];
}

/** The issue that a case's scenario should produce, if detected. */
export function targetIssue(c: EvalCase, issues: Issue[]): Issue | undefined {
  if (!c.scenario) return undefined;
  const s = scenario(c.scenario);
  return issues.find((i) => i.type === s.kind && s.invoice_ids.every((id) => i.invoice_ids.includes(id)) && (!i.type.match(/bank|suspicious/) || s.email_ids.every((e) => i.email_ids.includes(e))));
}

export function gradeDetection(c: EvalCase, issues: Issue[]): Grade {
  const reasons: string[] = [];
  if (c.id === 'noise') {
    const noisy = issues.filter((i) => i.email_ids.some((e) => truth.noise_email_ids.includes(e)));
    if (noisy.length) reasons.push(`noise emails raised issues: ${noisy.map((i) => i.issue_id).join(', ')}`);
    if (issues.length !== truth.scenarios.length) reasons.push(`expected ${truth.scenarios.length} issues, found ${issues.length}`);
    return { pass: reasons.length === 0, reasons };
  }
  const found = targetIssue(c, issues);
  if (c.expect.detected && !found) reasons.push('expected issue was not detected');
  if (!c.expect.detected && found) reasons.push(`issue ${found.issue_id} should not be detected`);
  return { pass: reasons.length === 0, reasons };
}

function matches(a: Action, m: ActionMatcher, invoices: string[]): boolean {
  if (a.type !== m.type) return false;
  if ('invoice_id' in a && !(m.invoice ? [m.invoice] : invoices).includes(a.invoice_id)) return false;
  if (m.take_discount !== undefined && (a.type !== 'schedule_payment' || a.take_discount !== m.take_discount)) return false;
  return true;
}

export function gradePlan(c: EvalCase, plan: Plan | null, failure: string | null): Grade {
  if (!plan) return { pass: false, reasons: [`no valid plan: ${failure ?? 'unknown'}`] };
  const reasons: string[] = [];
  const invoices = scenario(c.scenario!).invoice_ids;
  const e = c.expect;
  if (e.outcomes && !e.outcomes.includes(plan.outcome)) reasons.push(`outcome ${plan.outcome} not in [${e.outcomes.join(', ')}]`);
  if (e.requireAny && !plan.actions.some((a) => e.requireAny!.some((m) => matches(a, m, invoices)))) {
    reasons.push(`missing a required action: one of ${e.requireAny.map((m) => m.type).join(' / ')}`);
  }
  for (const a of plan.actions) {
    const bad = e.forbid?.find((m) => matches(a, m, invoices));
    if (bad) reasons.push(`forbidden action ${a.type}`);
  }
  return { pass: reasons.length === 0, reasons };
}
