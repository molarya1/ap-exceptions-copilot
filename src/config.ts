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
  const apiKey = process.env.ANTHROPIC_API_KEY || undefined;
  return {
    apiKey,
    // Live runs go through the logged-in Claude Code CLI when LIVE_VIA_CLAUDE_CODE=1 (the default
    // live path); the Messages API is used only when a key is set without it.
    liveVia: process.env.LIVE_VIA_CLAUDE_CODE === '1' ? ('claude-code' as const) : apiKey ? ('messages-api' as const) : null,
    model: process.env.AGENT_MODEL || 'claude-sonnet-5-5',
    effort: (process.env.AGENT_EFFORT || 'medium') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    port: Number(process.env.PORT || 4310),
  };
}
