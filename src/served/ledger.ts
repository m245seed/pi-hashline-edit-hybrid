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
 *
 * Every served entry carries the numeric context epoch it was served in
 * (PH-CONTEXT-001). Entries from older epochs do not authorize destructive
 * edits (PH-CONTEXT-003).
 */

import { getContextEpoch } from "./epoch";

export interface ServedEntry {
  exactText: string;
  epoch: number;
  /**
   * Last-known 0-based line index at serve time (§31.6 stale-anchor
   * recovery metadata). Optional because diff-served rows do not track it.
   */
  lastKnownLineIndex?: number;
  /** ISO timestamp when the row was served (§31.6). */
  servedAt?: string;
}

export type ServedLedger = Map<string, Map<string, ServedEntry>>;

const ledger: ServedLedger = new Map();

/**
 * Session-scoped "shown but now changed" markers (spec §71). When an
 * external change replaces a line that was previously served, the line's
 * fresh anchor is marked stale so the range check can report E_RANGE_STALE
 * ("the content the agent saw changed") instead of E_ANCHOR_NOT_SERVED.
 */
const staleAnchors: Map<string, Set<string>> = new Map();

export function getLedger(): ServedLedger {
  return ledger;
}

export interface ServeEntryInput {
  anchor: string;
  exactText: string;
  lineIndex?: number;
}

export function serveLine(path: string, anchor: string, exactText: string, lineIndex?: number): void {
  const entry: ServedEntry = { exactText, epoch: getContextEpoch(), servedAt: new Date().toISOString() };
  if (lineIndex !== undefined) entry.lastKnownLineIndex = lineIndex;
  putEntry(path, anchor, entry);
}

/** Store a fully-formed served entry (used for epoch-preserving transfers). */
function putEntry(path: string, anchor: string, entry: ServedEntry): void {
  let file = ledger.get(path);
  if (!file) {
    file = new Map();
    ledger.set(path, file);
  }
  file.set(anchor, entry);
}

export function serveLines(path: string, entries: Array<ServeEntryInput>): void {
  if (entries.length === 0) return;
  let file = ledger.get(path);
  if (!file) {
    file = new Map();
    ledger.set(path, file);
  }
  const epoch = getContextEpoch();
  const servedAt = new Date().toISOString();
  for (const entry of entries) {
    const stored: ServedEntry = { exactText: entry.exactText, epoch, servedAt };
    if (entry.lineIndex !== undefined) stored.lastKnownLineIndex = entry.lineIndex;
    file.set(entry.anchor, stored);
  }
}

/** Exact text previously served for (path, anchor), or undefined. */
export function servedText(path: string, anchor: string): string | undefined {
  return ledger.get(path)?.get(anchor)?.exactText;
}

/** Full served entry (text + epoch) for (path, anchor), or undefined. */
export function servedEntry(path: string, anchor: string): ServedEntry | undefined {
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
  for (const [anchor, entry] of file) {
    if (current.get(anchor) !== entry.exactText) {
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
 *   ("shown but now changed") rather than E_ANCHOR_NOT_SERVED.
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
    const oldEntry = servedEntry(path, oldAnchors[oldIdx]!);
    if (oldEntry !== undefined && oldEntry.exactText === newTexts[newIdx]!) {
      // Transfer the authorization as-is, preserving the epoch it was
      // actually served in (PH-CONTEXT-003): an external change must never
      // refresh an older epoch's authorization.
      putEntry(path, newAnchors[newIdx]!, { ...oldEntry, lastKnownLineIndex: newIdx });
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
