/**
 * Freeze handling (spec §12.5, §31.11).
 *
 * Sentinel can request hashline to refuse destructive tools temporarily.
 * Hashline maintains a set of active freeze IDs; while any freeze remains,
 * destructive tools (edit, insert, write, undo) reject with E_FROZEN, while
 * read and grep stay available. Unfreeze MUST name a specific freeze ID — a
 * broad "clear all" from another extension is never accepted.
 *
 * Freeze state is persisted for the session (meta table) so a reload does not
 * silently restore mutation capability.
 */

import { cachedPrepare, loadStore, prepareCached, requireStore, withBusyRetry } from "../state/database";
export interface FreezeRecord {
  freezeId: string;
  reasonCode: string;
  expiresAt?: string;
  receivedAt: string;
}

const FREEZE_META_KEY = "sentinel_freezes";

const activeFreezes = new Map<string, FreezeRecord>();

function isExpired(record: FreezeRecord): boolean {
  if (!record.expiresAt) return false;
  const at = Date.parse(record.expiresAt);
  return Number.isFinite(at) && at <= Date.now();
}

function pruneExpired(): void {
  for (const [id, record] of activeFreezes) {
    if (isExpired(record)) activeFreezes.delete(id);
  }
}

export function addFreeze(record: FreezeRecord): void {
  activeFreezes.set(record.freezeId, record);
  persistFreezes(serializeFreezes());
}

export function removeFreeze(freezeId: string): boolean {
  const removed = activeFreezes.delete(freezeId);
  if (removed) persistFreezes(serializeFreezes());
  return removed;
}

export function clearFreezesForTests(): void {
  activeFreezes.clear();
}

/** True when at least one non-expired freeze is active. */
export function isFrozen(): boolean {
  pruneExpired();
  return activeFreezes.size > 0;
}

export function activeFreezeIds(): string[] {
  pruneExpired();
  return [...activeFreezes.keys()];
}

/** E_FROZEN rejection message (spec §31.10). */
export function frozenRejection(operation: string): string {
  const ids = activeFreezeIds();
  return (
    `[E_FROZEN] Destructive ${operation} is temporarily refused: Sentinel has frozen hashline mutations ` +
    `(freeze id(s): ${ids.join(", ") || "unknown"}). Reads and grep remain available. Nothing was modified. ` +
    `Wait for the freeze to be lifted, or ask the user to resolve the Sentinel condition.`
  );
}

function serializeFreezes(): string {
  return JSON.stringify([...activeFreezes.values()]);
}

function writeFreezeRow(value: string): void {
  withBusyRetry(() =>
    cachedPrepare(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(FREEZE_META_KEY, value),
  );
}

let persistChain: Promise<void> = Promise.resolve();
let pendingValue: string | null = null;
let flushScheduled = false;

/**
 * Persist freeze state. When the store is already open the write is
 * synchronous so a restore immediately after a freeze sees it; otherwise it
 * is coalesced via queueMicrotask so rapid addFreeze/removeFreeze in the
 * same tick collapse to a single deferred write (PI:16).
 */
function persistFreezes(value: string): void {
  try {
    writeFreezeRow(value);
    return;
  } catch {
    // Store not open — coalesce deferred writes
  }
  pendingValue = value;
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    const toWrite = pendingValue;
    pendingValue = null;
    flushScheduled = false;
    if (toWrite === null) return;
    persistChain = persistChain
      .then(async () => {
        try {
          await loadStore();
          writeFreezeRow(toWrite);
        } catch {
          // Persistence is best-effort; in-memory state still enforces freezes.
        }
      })
      .catch(() => {});
  });
}

/** Restore persisted freeze state at session start (spec §12.5). */
export async function restoreFreezes(): Promise<void> {
  try {
    const store = await loadStore();
    const row = prepareCached(store, `SELECT value FROM meta WHERE key = ?`).get(
      FREEZE_META_KEY,
    ) as { value: string } | undefined;
    if (!row) return;
    const parsed = JSON.parse(row.value) as FreezeRecord[];
    for (const record of parsed) {
      if (
        record &&
        typeof record.freezeId === "string" &&
        typeof record.reasonCode === "string" &&
        !isExpired(record)
      ) {
        activeFreezes.set(record.freezeId, record);
      }
    }
  } catch {
    // Corrupt or missing freeze state starts unfrozen; Sentinel will
    // re-freeze on its next scan if the condition persists.
  }
}
