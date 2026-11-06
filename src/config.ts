// Every business rule reads "today" from here, never from the system clock.
export const BUSINESS_DATE = '2026-03-16'; // Monday payment run
export const NEXT_RUN_DATE = '2026-03-23';

export const COMPANY = {
  name: 'Quillfeather Provisions',
  domain: 'quillfeather.example',
  apInbox: 'ap@quillfeather.example',
};

// A match line is an exception only when the variance is beyond BOTH limits.
export const MATCH_TOLERANCE = { pct: 0.02, cents: 5_000 };

// Same vendor, same amount, invoice dates within this many days: possible duplicate.
export const DUPLICATE_WINDOW_DAYS = 7;

export const AGENT_LIMITS = {
  maxToolCalls: 16,
  extraPlanAttempts: 3, // submit_plan retries allowed beyond the tool budget
  deadlineMs: 180_000,
  queryRowCap: 50,
  concurrency: 2,
};

export const PATHS = {
  data: 'data',
  cache: 'cache/extractions.json',
  recorded: 'recorded',
  local: '.local',
};

export function env() {
  return {
    apiKey: process.env.ANTHROPIC_API_KEY || undefined,
    model: process.env.AGENT_MODEL || 'claude-sonnet-5-5',
    effort: (process.env.AGENT_EFFORT || 'medium') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    port: Number(process.env.PORT || 4310),
  };
}
