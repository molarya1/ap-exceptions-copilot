import { renderDocument } from '../actions/documents';
import { actionProblems } from '../actions/preconditions';
import type { Action } from '../actions/schema';
import { ActionSchema, claimKey } from '../actions/schema';
import { discountValue } from '../calc/discount';
import { matchCheck } from '../calc/match';
import type { Db } from '../lib/sqlite';
import { isCapability } from './capability';
import type { WorkStore } from './store';
import { payloadHash } from './store';

// Approval is the only path from a proposed action to the outbox. It requires:
//   1. a human capability minted by the HTTP layer,
//   2. the payload hash the person saw, equal to the stored payload's hash,
//   3. preconditions that still hold on current data,
//   4. a free claim for the commitment.
// Approval, claim and outbox row commit in one transaction, or not at all.

export type Decision = { ok: true; outboxId?: number } | { ok: false; refused: string; problems?: string[] };

export interface ApprovalDeps {
  store: WorkStore;
  facts: Db;
  /** Invoices in currently detected duplicate issues. */
  duplicateCopies: () => ReadonlyMap<string, string>;
}

class Refusal extends Error {
  constructor(
    readonly reason: string,
    readonly problems: string[] = [],
  ) {
    super(reason);
  }
}

function load(deps: ApprovalDeps, cap: unknown, actionId: string, shownHash: string): { action: Action; issueId: string } {
  if (!isCapability(cap)) throw new Refusal('no human capability: approvals come only from a signed-in browser session');
  const row = deps.store.action(actionId);
  if (!row) throw new Refusal(`no action ${actionId}`);
  if (row.status !== 'proposed') throw new Refusal(`action is already ${row.status}`);
  const action = ActionSchema.parse(JSON.parse(row.payload_json));
  if (payloadHash(action) !== row.payload_hash) throw new Refusal('stored payload does not match its hash');
  if (shownHash !== row.payload_hash) throw new Refusal('payload hash does not match what is stored; reload and review the action again');
  return { action, issueId: row.issue_id };
}

function refuse(deps: ApprovalDeps, cap: unknown, actionId: string, err: unknown): Decision {
  if (!(err instanceof Refusal)) throw err;
  const session = isCapability(cap) ? cap.sessionId : 'none';
  deps.store.log(`session:${session}`, 'approval_refused', { action_id: actionId, reason: err.reason, problems: err.problems });
  return { ok: false, refused: err.reason, ...(err.problems.length ? { problems: err.problems } : {}) };
}

export function approveAction(cap: unknown, deps: ApprovalDeps, actionId: string, shownHash: string): Decision {
  try {
    const { action, issueId } = load(deps, cap, actionId, shownHash);
    const { sessionId } = cap as { sessionId: string };

    const active = deps.store.db.get<{ active: number }>('SELECT active FROM issues WHERE issue_id = ?', [issueId]);
    if (!active?.active) throw new Refusal('the issue is no longer detected on current data');
    const problems = actionProblems(action, {
      db: deps.facts,
      calc: (id) => ({ match: matchCheck(deps.facts, id) ?? undefined, discount: discountValue(deps.facts, id) ?? undefined }),
      duplicateCopies: deps.duplicateCopies(),
      missingCalc: (_tool, id) => `invoice ${id} no longer exists`,
    });
    if (problems.length) throw new Refusal('preconditions no longer hold on current data', problems);

    const document = renderDocument(action, deps.facts);
    const at = new Date().toISOString();
    const outboxId = deps.store.tx(() => {
      const key = claimKey(action);
      const holder = deps.store.db.get<{ action_id: string }>('SELECT action_id FROM claims WHERE claim_key = ?', [key]);
      if (holder) throw new Refusal(`${key} is already committed by approved action ${holder.action_id}`);
      deps.store.db.run('INSERT INTO claims (claim_key, action_id, at) VALUES (?, ?, ?)', [key, actionId, at]);
      deps.store.db.run("UPDATE actions SET status = 'approved' WHERE action_id = ? AND status = 'proposed'", [actionId]);
      deps.store.db.run("INSERT INTO approvals (action_id, decision, payload_hash, session_id, at) VALUES (?, 'approved', ?, ?, ?)", [actionId, shownHash, sessionId, at]);
      deps.store.db.run('INSERT INTO outbox (action_id, kind, document_json, at) VALUES (?, ?, ?, ?)', [actionId, document.kind, JSON.stringify(document), at]);
      const { outbox_id } = deps.store.db.get<{ outbox_id: number }>('SELECT outbox_id FROM outbox WHERE action_id = ?', [actionId])!;
      deps.store.logInTx(`session:${sessionId}`, 'action_approved', { action_id: actionId, claim: key, outbox_id });
      return outbox_id;
    });
    return { ok: true, outboxId };
  } catch (err) {
    return refuse(deps, cap, actionId, err);
  }
}

export function rejectAction(cap: unknown, deps: ApprovalDeps, actionId: string, shownHash: string, reason: string): Decision {
  try {
    load(deps, cap, actionId, shownHash);
    const { sessionId } = cap as { sessionId: string };
    deps.store.tx(() => {
      deps.store.db.run("UPDATE actions SET status = 'rejected' WHERE action_id = ?", [actionId]);
      deps.store.db.run("INSERT INTO approvals (action_id, decision, payload_hash, session_id, reason, at) VALUES (?, 'rejected', ?, ?, ?, ?)", [actionId, shownHash, sessionId, reason, new Date().toISOString()]);
      deps.store.logInTx(`session:${sessionId}`, 'action_rejected', { action_id: actionId, reason });
    });
    return { ok: true };
  } catch (err) {
    return refuse(deps, cap, actionId, err);
  }
}
