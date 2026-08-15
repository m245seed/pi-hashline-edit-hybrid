/**
 * Persistent undo records (spec §32–§36).
 *
 * One undo transaction per file, persisted across restarts. The record keeps
 * the exact previous raw bytes (byte fidelity, spec §34) plus the exact
 * before/after anchor states so undo is a true restoration of document
 * identity, not merely text (spec §35).
 */

import { requireStore, withBusyRetry, type Store } from "./database";
import {
  decodeAnchorsBlob,
  decodeFingerprintsBlob,
  decodeRetiredBlob,
  type UndoPayload,
} from "./snapshots";

interface UndoRow {
  path: string;
  transaction_id: string;
  before_bytes: Uint8Array;
  after_checksum: string;
  before_anchors: Uint8Array;
  before_fingerprints: Uint8Array;
  before_retired: Uint8Array;
  after_anchors: Uint8Array;
  after_fingerprints: Uint8Array;
  after_retired: Uint8Array;
}

export interface UndoRecord {
  path: string;
  transactionId: string;
  beforeBytes: Buffer;
  afterChecksum: string;
  beforeAnchors: string[];
  beforeFingerprints: string[];
  beforeRetired: Set<string>;
  afterAnchors: string[];
  afterFingerprints: string[];
  afterRetired: Set<string>;
}

export function getUndoRecord(store: Store, path: string): UndoRecord | undefined {
  const row = store.db
    .prepare(
      `SELECT path, transaction_id, before_bytes, after_checksum,
         before_anchors, before_fingerprints, before_retired,
         after_anchors, after_fingerprints, after_retired
       FROM undo WHERE path = ?`,
    )
    .get(path) as UndoRow | undefined;
  if (!row) return undefined;
  const beforeLineCount = row.before_anchors.length / 4;
  const afterLineCount = row.after_anchors.length / 4;
  return {
    path: row.path,
    transactionId: row.transaction_id,
    beforeBytes: Buffer.from(row.before_bytes),
    afterChecksum: row.after_checksum,
    beforeAnchors: decodeAnchorsBlob(row.before_anchors, beforeLineCount),
    beforeFingerprints: decodeFingerprintsBlob(row.before_fingerprints, beforeLineCount),
    beforeRetired: decodeRetiredBlob(row.before_retired),
    afterAnchors: decodeAnchorsBlob(row.after_anchors, afterLineCount),
    afterFingerprints: decodeFingerprintsBlob(row.after_fingerprints, afterLineCount),
    afterRetired: decodeRetiredBlob(row.after_retired),
  };
}

export function deleteUndoRecord(store: Store, path: string): void {
  withBusyRetry(() => store.db.prepare(`DELETE FROM undo WHERE path = ?`).run(path));
}

export function undoPayloadToRecord(payload: UndoPayload): UndoRecord {
  return {
    path: payload.path,
    transactionId: payload.transactionId,
    beforeBytes: payload.beforeBytes,
    afterChecksum: payload.afterChecksum,
    beforeAnchors: payload.beforeAnchors,
    beforeFingerprints: payload.beforeFingerprints,
    beforeRetired: payload.beforeRetired,
    afterAnchors: payload.afterAnchors,
    afterFingerprints: payload.afterFingerprints,
    afterRetired: payload.afterRetired,
  };
}

export async function loadUndoRecord(path: string): Promise<UndoRecord | undefined> {
  const store = await requireStoreAsync();
  return getUndoRecord(store, path);
}

export async function clearUndoRecord(path: string): Promise<void> {
  const store = await requireStoreAsync();
  deleteUndoRecord(store, path);
}

async function requireStoreAsync(): Promise<Store> {
  // The store is opened at session start; requireStore throws a clear
  // state error if it was never opened.
  return requireStore();
}
