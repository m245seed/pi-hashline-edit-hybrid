/**
 * Served-state ledger (spec §8, §9).
 *
 * A line becomes served only when its complete current contents are actually
 * returned to the model in the current Pi session. The ledger records
 * (path, anchor) -> exactText for every fully rendered row from `read`,
 * `grep`, edit diffs, undo diffs, and fresh error feedback.
 *
 * The ledger is session-scoped by design (spec §8.1): anchors and undo
 * survive restarts, but permission to destructively edit previously viewed
 * lines does not — after a restart, `read`/`grep` is required again.
 */

export type ServedLedger = Map<string, Map<string, string>>;

const ledger: ServedLedger = new Map();

/**
 * Session-scoped "shown but now changed" markers (spec §71). When an
 * external change replaces a line that was previously served, the line's
 * fresh anchor is marked stale so the range check can report E_RANGE_STALE
 * ("the content the agent saw changed") instead of E_RANGE_UNSERVED.
 */
const staleAnchors: Map<string, Set<string>> = new Map();

export function getLedger(): ServedLedger {
  return ledger;
}

export function serveLine(path: string, anchor: string, exactText: string): void {
  let file = ledger.get(path);
  if (!file) {
    file = new Map();
    ledger.set(path, file);
  }
  file.set(anchor, exactText);
}

export function serveLines(path: string, entries: Array<{ anchor: string; exactText: string }>): void {
  if (entries.length === 0) return;
  let file = ledger.get(path);
  if (!file) {
    file = new Map();
    ledger.set(path, file);
  }
  for (const entry of entries) {
    file.set(entry.anchor, entry.exactText);
  }
}

/** Exact text previously served for (path, anchor), or undefined. */
export function servedText(path: string, anchor: string): string | undefined {
  return ledger.get(path)?.get(anchor);
}

export function markStale(path: string, anchor: string): void {
  let set = staleAnchors.get(path);
  if (!set) {
    set = new Set();
    staleAnchors.set(path, set);
  }
  set.add(anchor);
}

export function isStale(path: string, anchor: string): boolean {
  return staleAnchors.get(path)?.has(anchor) ?? false;
}

export function clearServedPath(path: string): void {
  ledger.delete(path);
  staleAnchors.delete(path);
}

/**
 * Invalidate served authorization after a whole-file write (spec §37):
 * keep entries whose line still exists with identical content, drop the rest.
 */
export function pruneServedPath(
  path: string,
  current: Map<string, string>,
): void {
  const file = ledger.get(path);
  if (!file) return;
  for (const [anchor, text] of file) {
    if (current.get(anchor) !== text) {
      file.delete(anchor);
    }
  }
}

export function clearServedAll(): void {
  ledger.clear();
  staleAnchors.clear();
}

/** Test helper. */
export function resetServed(): void {
  ledger.clear();
  staleAnchors.clear();
}

/**
 * Reconcile served authorization against an externally changed document
 * (spec §7, §71).
 *
 * - Lines preserved by the alignment keep (or transfer) their authorization.
 * - A line that was served before and now changed keeps a stale marker on
 *   its fresh anchor, so authorization failures report E_RANGE_STALE
 *   ("shown but now changed") rather than E_RANGE_UNSERVED.
 * - Served entries for removed lines stay dormant; their anchors are
 *   retired and can only become live again through undo (which restores
 *   the exact bytes, so the entry remains valid).
 */
export function reconcileServed(
  path: string,
  oldAnchors: readonly string[],
  mapping: ReadonlyMap<number, number>,
  newAnchors: readonly string[],
  newTexts: readonly string[],
): void {
  for (const [newIdx, oldIdx] of mapping) {
    const oldServed = servedText(path, oldAnchors[oldIdx]!);
    if (oldServed !== undefined && oldServed === newTexts[newIdx]!) {
      serveLine(path, newAnchors[newIdx]!, newTexts[newIdx]!);
    }
  }
  const servedOldIndexes = new Set<number>();
  for (let i = 0; i < oldAnchors.length; i++) {
    if (servedText(path, oldAnchors[i]!) !== undefined) servedOldIndexes.add(i);
  }
  if (servedOldIndexes.size === 0) return;
  const mappedNewSorted = [...mapping.keys()].sort((a, b) => a - b);
  for (let j = 0; j < newAnchors.length; j++) {
    if (mapping.has(j)) continue;
    let prevOld = -1;
    let nextOld = oldAnchors.length;
    for (const mappedNew of mappedNewSorted) {
      if (mappedNew < j) prevOld = Math.max(prevOld, mapping.get(mappedNew)!);
      else if (mappedNew > j) {
        nextOld = Math.min(nextOld, mapping.get(mappedNew)!);
        break;
      }
    }
    let gapServed = false;
    for (let i = prevOld + 1; i < nextOld; i++) {
      if (servedOldIndexes.has(i)) {
        gapServed = true;
        break;
      }
    }
    if (gapServed) markStale(path, newAnchors[j]!);
  }
}
