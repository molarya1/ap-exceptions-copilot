import type Anthropic from '@anthropic-ai/sdk';
import { messagesTransport } from '../../src/llm/messages';
import type { Transport } from '../../src/llm/transport';
import { rawFixtureExtractions } from './extractions';
import { message } from './fake-api';
import { scriptedAgent } from './scripted-agent';

// Test transports: the real Messages API transport over fake APIs. Nothing leaves the process.

/** The scripted agent policy, as a transport. */
export const scriptedTransport = (): Transport => messagesTransport(scriptedAgent(), 'claude-sonnet-5-5', 'medium');

/** Answers every extraction request with the hand-written fixture for that email. */
export function fixtureExtractionTransport(): Transport {
  const raw = rawFixtureExtractions();
  let n = 0;
  return messagesTransport(
    {
      async create(params) {
        const id = /<email id="(m\d+)">/.exec(String(params.messages[0]!.content))![1]!;
        if (params.messages.length > 1) return message([{ type: 'text', text: 'Done.', citations: null } as Anthropic.TextBlock], 'end_turn');
        return message([{ type: 'tool_use', id: `toolu_x${n++}`, name: 'submit_extraction', input: raw.get(id)! } as Anthropic.ToolUseBlock], 'tool_use');
      },
    },
    'fixture',
    'low',
  );
}
