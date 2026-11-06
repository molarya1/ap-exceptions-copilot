import { z } from 'zod';
import { ActionSchema } from '../actions/schema';

// A plan: the agent's decision on one issue, submitted through the submit_plan tool.

export const OUTCOMES = ['act', 'hold_and_ask', 'no_action'] as const;

export const PlanSchema = z.object({
  summary: z.string().describe('Two or three sentences: what is going on and what you recommend.'),
  options: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
        consequences: z.string().describe('What happens, in money and risk, if this option is chosen.'),
        chosen: z.boolean(),
      }),
    )
    .describe('At least two real options, including doing nothing. Exactly one is chosen.'),
  outcome: z.enum(OUTCOMES),
  rationale: z.string().describe('Why the chosen option beats the others, citing evidence ids.'),
  actions: z.array(ActionSchema).describe('The typed actions of the chosen option. Empty for no_action.'),
  open_questions: z.array(z.string()).describe('Questions a person must answer. Required for hold_and_ask.'),
  evidence_ids: z.array(z.string()).describe('Invoice, email, PO line and receipt ids that support the decision.'),
});

export type Plan = z.infer<typeof PlanSchema>;
