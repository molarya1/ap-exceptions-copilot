// An issue: something that needs a decision before the payment run.

export const ISSUE_TYPES = ['duplicate_invoice', 'match_exception', 'discount_expiring', 'bank_change_request', 'suspicious_message'] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export interface Ranking {
  score: number;
  money_points: number;
  urgency_points: number;
  flag_points: number;
  explanation: string;
}

export interface Issue {
  issue_id: string; // stable across restarts: derived from what was detected
  type: IssueType;
  title: string;
  vendor_id: string;
  invoice_ids: string[];
  email_ids: string[];
  money_at_risk_usd_cents: number;
  deadline: string;
  evidence_ids: string[];
  details: Record<string, unknown>;
  ranking: Ranking;
}

export type DetectedIssue = Omit<Issue, 'ranking'>;
