import Anthropic from '@anthropic-ai/sdk';
import { claudeCodeTransport } from './claude-code';
import { messagesTransport } from './messages';
import type { Effort, Transport } from './transport';

// Which live transport to use, from the environment. Claude Code is the default when
// LIVE_VIA_CLAUDE_CODE=1; the Messages API is used only when an API key is set without it.

export type LiveVia = 'claude-code' | 'messages-api' | null;

export function liveTransport(via: LiveVia, model: string, effort: Effort, apiKey?: string): Transport | null {
  if (via === 'claude-code') return claudeCodeTransport(model, effort);
  if (via === 'messages-api') return messagesTransport(new Anthropic({ apiKey }).messages, model, effort);
  return null;
}
