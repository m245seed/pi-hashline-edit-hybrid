/**
 * Context epochs (PH-CONTEXT-001..005).
 *
 * Served authorizations belong to a numeric context epoch. The epoch
 * advances when the model's context is rebuilt (compaction, tree navigation,
 * session transition) — either observed directly or announced by Sentinel
 * over IPC. Anchors served in an older epoch MUST NOT authorize destructive
 * edits: the model can no longer be assumed to hold their exact content.
 *
 * Undo history and file identity are independent of the epoch (PH-CONTEXT-005):
 * advancing the epoch never clears undo records or anchor state.
 */

let currentEpoch = 1;

export function getContextEpoch(): number {
  return currentEpoch;
}

/**
 * Advance the epoch by one. Returns the new epoch. Idempotency is not
 * required: every observed context rebuild advances the epoch, and served
 * entries stamped with older epochs stop authorizing destructive edits.
 */
export function advanceContextEpoch(reason?: string): number {
  void reason;
  currentEpoch += 1;
  return currentEpoch;
}

/** Set a specific epoch (used when Sentinel announces an absolute value). */
export function setContextEpoch(epoch: number): void {
  if (Number.isFinite(epoch) && epoch > currentEpoch) {
    currentEpoch = Math.floor(epoch);
  }
}

/** Test helper. */
export function resetContextEpoch(): void {
  currentEpoch = 1;
}
