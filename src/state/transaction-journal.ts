/**
 * Crash-recovery journal (spec §29 Phase 3, §31).
 *
 * Filesystem mutation and the SQLite commit cannot form a single truly
 * atomic transaction, so every mutation first persists a
 * `pending_transactions` row containing enough information to recover both
 * the pre- and post-state. Startup recovery then decides, from the file's
 * actual checksum, whether the commit never happened, happened but was not
 * finalized, or collided with an external writer.
 */

import { randomUUID } from "crypto";
import { cachedPrepare, prepareCached, requireStore, withBusyRetry, type Store } from "./database";
import {
  decodeAnchorsBlob,
  decodeFingerprintsBlob,
  decodeRetiredBlob,
  encodeAnchorsBlob,
  encodeFingerprintsBlob,
  encodeRetiredBlob,
} from "./snapshots";

export interface PendingState {
  anchors: string[];
  fingerprints: string[];
  retired: Set<string>;
  lineCount: number;
}

export interface PendingTransaction {
  transactionId: string;
  path: string;
  beforeChecksum: string;
  afterChecksum: string;
  before: PendingState;
  after: PendingState;
  /** Undo payload to create on promotion (null when the mutation was itself an undo). */
  undo: {
    beforeBytes: Buffer;
    afterChecksum: string;
    beforeAnchors: string[];
    beforeFingerprints: string[];
    beforeRetired: Set<string>;
  } | null;
  createdAt: number;
}

interface PendingRow {
  transaction_id: string;
  path: string;
  before_checksum: string;
  after_checksum: string;
  before_anchors: Uint8Array;
  before_fingerprints: Uint8Array;
  before_retired: Uint8Array;
  before_line_count: number;
  after_anchors: Uint8Array;
  after_fingerprints: Uint8Array;
  after_retired: Uint8Array;
  after_line_count: number;
  undo_before_bytes: Uint8Array | null;
  undo_after_checksum: string | null;
  undo_before_anchors: Uint8Array | null;
  undo_before_fingerprints: Uint8Array | null;
  undo_before_retired: Uint8Array | null;
  created_at: number;
}

function encodeState(state: PendingState): {
  anchors: Buffer;
  fingerprints: Buffer;
  retired: Buffer;
} {
  return {
    anchors: encodeAnchorsBlob(state.anchors),
    fingerprints: encodeFingerprintsBlob(state.fingerprints),
    retired: encodeRetiredBlob(state.retired),
  };
}

function decodeState(row: PendingRow, prefix: "before" | "after"): PendingState {
  const anchors = row[`${prefix}_anchors`];
  const fingerprints = row[`${prefix}_fingerprints`];
  const retired = row[`${prefix}_retired`];
  const lineCount = row[`${prefix}_line_count`];
  return {
    anchors: decodeAnchorsBlob(anchors, lineCount),
    fingerprints: decodeFingerprintsBlob(fingerprints, lineCount),
    retired: decodeRetiredBlob(retired),
    lineCount,
  };
}

export function newTransactionId(): string {
  return randomUUID();
}

export function insertPendingTransaction(entry: PendingTransaction): void {
  const store = requireStore();
  const before = encodeState(entry.before);
  const after = encodeState(entry.after);
  withBusyRetry(() =>
    cachedPrepare(
      `INSERT INTO pending_transactions (
           transaction_id, path, before_checksum, after_checksum,
           before_anchors, before_fingerprints, before_retired, before_line_count,
           after_anchors, after_fingerprints, after_retired, after_line_count,
           undo_before_bytes, undo_after_checksum,
           undo_before_anchors, undo_before_fingerprints, undo_before_retired,
           created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        entry.transactionId,
        entry.path,
        entry.beforeChecksum,
        entry.afterChecksum,
        before.anchors,
        before.fingerprints,
        before.retired,
        entry.before.lineCount,
        after.anchors,
        after.fingerprints,
        after.retired,
        entry.after.lineCount,
        entry.undo?.beforeBytes ?? null,
        entry.undo?.afterChecksum ?? null,
        entry.undo
          ? encodeAnchorsBlob(entry.undo.beforeAnchors)
          : null,
        entry.undo
          ? encodeFingerprintsBlob(entry.undo.beforeFingerprints)
          : null,
        entry.undo ? encodeRetiredBlob(entry.undo.beforeRetired) : null,
        entry.createdAt,
      ),
  );
}

export function listPendingTransactions(store: Store): PendingTransaction[] {
  const rows = prepareCached(
    store,
    `SELECT * FROM pending_transactions ORDER BY created_at`,
  ).all() as unknown as PendingRow[];
  return rows.map((row) => ({
    transactionId: row.transaction_id,
    path: row.path,
    beforeChecksum: row.before_checksum,
    afterChecksum: row.after_checksum,
    before: decodeState(row, "before"),
    after: decodeState(row, "after"),
    undo:
      row.undo_before_bytes !== null && row.undo_after_checksum !== null
        ? (() => {
            const lineCount = row.undo_before_anchors!.length / 4;
            return {
              beforeBytes: Buffer.from(row.undo_before_bytes),
              afterChecksum: row.undo_after_checksum,
              beforeAnchors: decodeAnchorsBlob(row.undo_before_anchors!, lineCount),
              beforeFingerprints: decodeFingerprintsBlob(
                row.undo_before_fingerprints!,
                lineCount,
              ),
              beforeRetired: decodeRetiredBlob(row.undo_before_retired!),
            };
          })()
        : null,
    createdAt: row.created_at,
  }));
}

export function deletePendingTransaction(store: Store, transactionId: string): void {
  withBusyRetry(() =>
    prepareCached(store, `DELETE FROM pending_transactions WHERE transaction_id = ?`).run(
      transactionId,
    ),
  );
}
