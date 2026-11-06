// The human capability: proof that a request came from a person's browser session.
// Only the HTTP layer mints one (lint forbids importing mintCapability elsewhere), and
// approval functions accept only objects minted here. A look-alike object is refused.

declare const brand: unique symbol;
export interface HumanCapability {
  readonly sessionId: string;
  readonly [brand]: true;
}

const minted = new WeakSet<object>();

export function mintCapability(sessionId: string): HumanCapability {
  const cap = Object.freeze({ sessionId }) as HumanCapability;
  minted.add(cap);
  return cap;
}

export function isCapability(value: unknown): value is HumanCapability {
  return typeof value === 'object' && value !== null && minted.has(value);
}
