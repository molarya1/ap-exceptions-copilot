import type Anthropic from '@anthropic-ai/sdk';

// USD per million tokens. Cache writes (5-minute TTL) cost 1.25x input.
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export const emptyUsage = (): UsageTotals => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

export function addUsage(total: UsageTotals, u: Anthropic.Usage): void {
  total.input_tokens += u.input_tokens;
  total.output_tokens += u.output_tokens;
  total.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
  total.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
}

/** Estimated cost in USD, or null for a model without a known price. */
export function costUsd(model: string, u: UsageTotals): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const usd = (u.input_tokens * p.input + u.cache_creation_input_tokens * p.input * 1.25 + u.cache_read_input_tokens * p.cacheRead + u.output_tokens * p.output) / 1e6;
  return Math.round(usd * 10_000) / 10_000;
}
