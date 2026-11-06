import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { addUsage, costUsd, emptyUsage } from './cost';
import type { Conversation, Effort, Transport, TransportResult } from './transport';

// Optional live path (ANTHROPIC_API_KEY): a plain Messages API tool loop with prompt caching.

/** The slice of the Anthropic client this transport needs. Tests pass fakes. */
export interface MessagesApi {
  create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
}

function inputSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const { $schema: _drop, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return json as Anthropic.Tool.InputSchema;
}

export function messagesTransport(api: MessagesApi, model: string, effort: Effort): Transport {
  return {
    name: 'messages-api',
    model,
    async run(c: Conversation): Promise<TransportResult> {
      const usage = emptyUsage();
      const end = (ended: TransportResult['ended'], detail: string | null = null): TransportResult => ({ ended, detail, usage, cost_usd: costUsd(model, usage), cost_estimated: false });
      // The system block and the last tool carry the cache breakpoints.
      const tools: Anthropic.Tool[] = c.tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: inputSchema(t.input),
        ...(i === c.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
      }));
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: c.user }];
      let nudged = false;

      for (let turn = 0; ; turn++) {
        if (turn >= c.maxTurns) return end('budget');
        const remaining = c.deadline - Date.now();
        if (remaining <= 0) return end('timeout');

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), remaining);
        let response: Anthropic.Message;
        try {
          response = await api.create(
            { model, max_tokens: 16_000, system: [{ type: 'text', text: c.system, cache_control: { type: 'ephemeral' } }], tools, messages, output_config: { effort } },
            { signal: abort.signal },
          );
        } catch (err) {
          return abort.signal.aborted ? end('timeout') : end('model_error', (err as Error).message);
        } finally {
          clearTimeout(timer);
        }

        addUsage(usage, response.usage);
        c.onTurn?.(response.content);
        messages.push({ role: 'assistant', content: response.content });
        if (response.stop_reason === 'refusal') return end('refusal');
        if (response.stop_reason === 'max_tokens') return end('max_tokens');

        const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (uses.length === 0) {
          if (nudged) return end('no_tool_call');
          nudged = true;
          messages.push({ role: 'user', content: `Finish by calling ${c.tools.at(-1)!.name}.` });
          continue;
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        let stop = false;
        for (const use of uses) {
          const r = await c.call(use.name, use.input);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: r.text, ...(r.isError ? { is_error: true } : {}) });
          stop ||= Boolean(r.stop);
        }
        if (stop) return end('stopped');
        messages.push({ role: 'user', content: results });
      }
    },
  };
}
