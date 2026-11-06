import type { z } from 'zod';
import type { UsageTotals } from './cost';

// A transport carries one conversation between our tools and a model. The investigation
// loop and email extraction only ever see this interface, so limits, checks and audit
// are the same whether the model is reached through Claude Code or the Messages API.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ToolSpec {
  name: string;
  description: string;
  input: z.ZodObject; // validated again by `call`; the transport only advertises it
}

export interface ToolReply {
  text: string;
  isError: boolean;
  /** The conversation is over (plan accepted, or too many rejections). */
  stop?: boolean;
}

export interface Conversation {
  system: string;
  user: string;
  tools: ToolSpec[];
  call: (name: string, input: unknown) => Promise<ToolReply>;
  /** Wall-clock deadline, as a Date.now() timestamp. */
  deadline: number;
  /** Model turns allowed, tied to the tool budget. */
  maxTurns: number;
  /** Every model turn, for the run's audit log. */
  onTurn?: (content: unknown) => void;
}

export type TransportFailure =
  | 'budget' // ran out of turns
  | 'timeout' // the deadline passed
  | 'cli_unavailable' // Claude Code not installed, not logged in, or would not start
  | 'refusal'
  | 'max_tokens'
  | 'no_tool_call' // the model stopped without finishing
  | 'model_error';

export interface TransportResult {
  /** 'stopped' when a tool reply ended the conversation; otherwise why it ended. */
  ended: 'stopped' | TransportFailure;
  detail: string | null;
  usage: UsageTotals;
  cost_usd: number | null;
  /** Claude Code reports its own estimate; the Messages API path prices tokens itself. */
  cost_estimated: boolean;
}

export interface Transport {
  readonly name: 'claude-code' | 'messages-api' | 'replay';
  readonly model: string;
  run(conversation: Conversation): Promise<TransportResult>;
}

export const FAILURE_TEXT: Record<TransportFailure, string> = {
  budget: 'ran out of model turns',
  timeout: 'wall-clock deadline reached',
  cli_unavailable: 'Claude Code is not available (install it and run `claude` once to log in)',
  refusal: 'the model declined the request',
  max_tokens: 'the response hit max_tokens',
  no_tool_call: 'ended without submitting',
  model_error: 'model call failed',
};
