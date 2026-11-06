import { BUSINESS_DATE } from '../config';
import { daysBetween } from '../lib/dates';
import { formatCents } from '../lib/money';
import type { DetectedIssue, Issue, Ranking } from './types';

// Ranking = money at risk (log scale) + urgency from the deadline + one point per trust flag.
// Each input is shown on the issue, so a person can see why it sits where it does.

export function rank(issue: DetectedIssue): Ranking {
  const days = daysBetween(BUSINESS_DATE, issue.deadline);
  const money = Math.log10(1 + issue.money_at_risk_usd_cents / 100);
  const urgency = 3 * Math.min(1, Math.max(0, 1 - days / 14)); // 3 points today, 0 at two weeks out
  const flags = Array.isArray(issue.details.flags) ? issue.details.flags.length : 0;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return {
    score: r1(money + urgency + flags),
    money_points: r1(money),
    urgency_points: r1(urgency),
    flag_points: flags,
    explanation: `${formatCents(issue.money_at_risk_usd_cents)} at risk → ${r1(money)} · deadline ${issue.deadline} (${days} days) → ${r1(urgency)} · ${flags} trust flag${flags === 1 ? '' : 's'} → ${flags}`,
  };
}

export function rankAll(issues: DetectedIssue[]): Issue[] {
  return issues
    .map((i) => ({ ...i, ranking: rank(i) }))
    .sort((a, b) => b.ranking.score - a.ranking.score || a.issue_id.localeCompare(b.issue_id));
}
