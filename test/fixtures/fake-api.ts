import type Anthropic from '@anthropic-ai/sdk';
import type { MessagesApi } from '../../src/agent/loop';

// A fake Messages API. Each turn is a function of the request so far, returning the
// assistant's content blocks. Tool-use ids are generated, like the real API does.

export type Turn = (params: Anthropic.MessageCreateParamsNonStreaming) => Array<{ tool: string; input: unknown } | { text: string }>;

export function message(content: Anthropic.ContentBlock[], stop: Anthropic.Message['stop_reason']): Anthropic.Message {
  return {
    id: `msg_fake_${Math.random().toString(36).slice(2, 10)}`,
    type: 'message',
    role: 'assistant',
    model: 'fake-model',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

export function scripted(turns: Turn[]): MessagesApi & { requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let n = 0;
  return {
    requests,
    async create(params) {
      requests.push(structuredClone(params));
      const turn = turns[Math.min(n++, turns.length - 1)]!;
      const blocks = turn(params).map((b, i): Anthropic.ContentBlock =>
        'tool' in b
          ? ({ type: 'tool_use', id: `toolu_${n}_${i}`, name: b.tool, input: b.input } as Anthropic.ToolUseBlock)
          : ({ type: 'text', text: b.text, citations: null } as Anthropic.TextBlock),
      );
      return message(blocks, blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
    },
  };
}

/** The tool_result blocks the loop sent back in the latest request. */
export function lastToolResults(params: Anthropic.MessageCreateParamsNonStreaming): Anthropic.ToolResultBlockParam[] {
  const last = params.messages.at(-1);
  return Array.isArray(last?.content) ? (last.content.filter((b) => b.type === 'tool_result') as Anthropic.ToolResultBlockParam[]) : [];
}
