import type { Db } from '../lib/sqlite';
import { detectDuplicates, detectExpiringDiscounts, detectMatchExceptions, detectMessages } from './detectors';
import { rankAll } from './rank';
import type { Issue } from './types';

/** All detectors over facts.db, ranked. Deterministic: same facts, same queue. */
export function detectIssues(db: Db): Issue[] {
  return rankAll([...detectDuplicates(db), ...detectMatchExceptions(db), ...detectExpiringDiscounts(db), ...detectMessages(db)]);
}
