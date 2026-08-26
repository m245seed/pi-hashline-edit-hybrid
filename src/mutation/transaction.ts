/**
 * Transaction orchestration (spec §19, §29, §47).
 *
 * Steps: validate → resolve target → per-file mutation lock → read once →
 * reconcile anchors → resolve anchors → verify served state → convert to
 * source ranges → sort → reject overlap → calculate in memory → validate
 * result → journal → precommit check → commit file → finalize state →
 * return one combined anchored diff. Any failure before commit applies zero
 * edits. Cancellation is allowed before commit; after the rename the
 * extension finishes consistency work (spec §47).
 */

import { readFile } from "fs/promises";
import { ANCHOR_SPACE } from "../anchors/alphabet";
import { ANCHOR_SPACE_PRESSURE_RATIO } from "../constants";
import { fingerprintHexes } from "../anchors/fingerprints";
import { reconcileState } from "../anchors/reconcile";
import { decodeDocument, encodeDocument } from "../document/decode";
import { assertFileKind, assertLineCount, checkFileKind } from "../document/file-kind";
import { hasMixedLineEndings, type Document, type TextLine } from "../document/lines";
import { reconcileServed } from "../served/ledger";
import { loadStore, requireStore, withBusyRetry } from "../state/database";
import {
  getSnapshot,
  putSnapshot,
  finalizeTransaction,
  type FileSnapshot,
  type UndoPayload,
} from "../state/snapshots";
import {
  insertPendingTransaction,
  newTransactionId,
  type PendingState,
} from "../state/transaction-journal";
import {
  inspectTarget,
  prepareTempWrite,
  commitTempFile,
  removeTempFile,
  precommitVerify,
  writeInPlace,
} from "../filesystem/atomic-write";
import { errCode, sha256Hex } from "../utils";
import type { EditMetrics } from "./apply";
import type { FinalNewline } from "./validate";

export interface AnchoredFile {
  realPath: string;
  raw: Buffer;
  checksum: string;
  doc: Document;
  texts: string[];
  anchors: string[];
  fingerprints: string[];
  retired: Set<string>;
}

/**
 * Read the file once, decode strictly, and reconcile anchors (spec §19
 * steps 4–5). Persists the reconciled state so anchors survive restarts and
 * external edits.
 */
export async function loadAnchoredFile(
  realPath: string,
  label: string,
): Promise<AnchoredFile> {
  let kind: Awaited<ReturnType<typeof checkFileKind>>;
  try {
    kind = await checkFileKind(realPath, label);
  } catch (error: unknown) {
    // A missing target must fail with the anchored protocol error, not a
    // raw ENOENT from stat (the readFile branch below never runs for it).
    if (errCode(error) === "ENOENT") {
      throw new Error(
        `[E_BAD_REF] ${label} does not exist. Use read() to inspect the file before editing.`,
      );
    }
    throw error;
  }
  assertFileKind(kind, label);
  let raw: Buffer;
  try {
    raw = await readFile(realPath);
  } catch (error: unknown) {
    if (errCode(error) === "ENOENT") {
      throw new Error(
        `[E_BAD_REF] ${label} does not exist. Use read() to inspect the file before editing.`,
      );
    }
    throw error;
  }
  const doc = decodeDocument(raw, label);
  assertLineCount(doc.lines.length, label);
  const checksum = sha256Hex(raw);
  const texts = doc.lines.map((line) => line.text);
  const store = await loadStore();
  const snapshot = getSnapshot(store, realPath);
  if (snapshot && snapshot.rawChecksum === checksum) {
    return {
      realPath,
      raw,
      checksum,
      doc,
      texts,
      anchors: snapshot.anchors,
      fingerprints: snapshot.fingerprints,
      retired: snapshot.retired,
    };
  }
  const fingerprints = fingerprintHexes(texts);
  const reconciled = reconcileState(
    snapshot,
    snapshot?.retired ?? new Set<string>(),
    texts,
    fingerprints,
  );
  if (snapshot) {
    // Keep served authorization consistent with the external change.
    reconcileServed(
      realPath,
      snapshot.anchors,
      reconciled.mapping,
      reconciled.anchors,
      texts,
    );
  }
  const retired = new Set(snapshot?.retired);
  for (const a of reconciled.retiredAdded) retired.add(a);
  const newSnapshot: FileSnapshot = {
    path: realPath,
    rawChecksum: checksum,
    lineCount: texts.length,
    anchors: reconciled.anchors,
    fingerprints,
    retired,
    updatedAt: Date.now(),
  };
  putSnapshot(store, realPath, newSnapshot);
  return {
    realPath,
    raw,
    checksum,
    doc,
    texts,
    anchors: reconciled.anchors,
    fingerprints,
    retired: newSnapshot.retired,
  };
}

export interface CommitInput {
  realPath: string;
  /** Display path used in messages. */
  label: string;
  rawBefore: Buffer;
  checksumBefore: string;
  docBefore: Document;
  anchorsBefore: string[];
  fingerprintsBefore: string[];
  retiredBefore: Set<string>;
  rawAfter: Buffer;
  checksumAfter: string;
  docAfter: Document;
  anchorsAfter: string[];
  fingerprintsAfter: string[];
  retiredAfter: Set<string>;
  transactionId: string;
  signal?: AbortSignal;
  expectedRevision?: string;
  /** False for undo operations (undo never creates a new undo record). */
  keepUndo: boolean;
  warnings: string[];
  /** True when committing a brand-new file (target must still be absent). */
  expectAbsent?: boolean;
}

/**
 * Commit one mutation with the full protocol (spec §29). Throws before
 * committing on any validation failure; after the rename, finalization
 * always completes and the pending journal row is left for startup
 * recovery only if finalization itself fails.
 */
export async function commitMutation(input: CommitInput): Promise<void> {
  const {
    realPath,
    label,
    rawBefore,
    checksumBefore,
    docBefore,
    anchorsBefore,
    fingerprintsBefore,
    retiredBefore,
    rawAfter,
    checksumAfter,
    docAfter,
    anchorsAfter,
    fingerprintsAfter,
    retiredAfter,
    transactionId,
    signal,
    expectedRevision,
    keepUndo,
    warnings,
    expectAbsent,
  } = input;

  if (expectedRevision !== undefined && expectedRevision !== checksumBefore) {
    throw new Error(
      `[E_FILE_REVISION_CHANGED] The current file revision does not match expected_revision. Nothing was modified.`,
    );
  }
  abortCheck(signal);
  const store = await loadStore();

  const beforeState: PendingState = {
    anchors: anchorsBefore,
    fingerprints: fingerprintsBefore,
    retired: retiredBefore,
    lineCount: docBefore.lines.length,
  };
  const afterState: PendingState = {
    anchors: anchorsAfter,
    fingerprints: fingerprintsAfter,
    retired: retiredAfter,
    lineCount: docAfter.lines.length,
  };
  const undoPayload: UndoPayload = {
    path: realPath,
    transactionId,
    beforeBytes: rawBefore,
    afterChecksum: checksumAfter,
    beforeAnchors: anchorsBefore,
    beforeFingerprints: fingerprintsBefore,
    beforeRetired: retiredBefore,
    afterAnchors: anchorsAfter,
    afterFingerprints: fingerprintsAfter,
    afterRetired: retiredAfter,
  };

  // Phase 3 — journal.
  insertPendingTransaction({
    transactionId,
    path: realPath,
    beforeChecksum: checksumBefore,
    afterChecksum: checksumAfter,
    before: beforeState,
    after: afterState,
    undo: keepUndo
      ? {
          beforeBytes: rawBefore,
          afterChecksum: checksumAfter,
          beforeAnchors: anchorsBefore,
          beforeFingerprints: fingerprintsBefore,
          beforeRetired: retiredBefore,
        }
      : null,
    createdAt: Date.now(),
  });

  const content = rawAfter.toString("utf-8");
  const target = await inspectTarget(realPath);
  let tempPath: string | undefined;
  let fileCommitted = false;
  try {
    // Phases 4–5.
    if (target.hardlink) {
      await precommitVerify(realPath, realPath, rawBefore, expectAbsent === true);
      abortCheck(signal);
      await writeInPlace(target.targetPath, content, target.mode);
      fileCommitted = true;
      warnings.push(
        `[W_HARDLINK_NONATOMIC] ${label} has multiple hard links. The edit preserved the shared inode, so the write could not use atomic rename semantics.`,
      );
    } else {
      try {
        tempPath = await prepareTempWrite(
          target.targetPath,
          content,
          target.mode ?? (expectAbsent ? 0o644 : undefined),
        );
        await precommitVerify(realPath, realPath, rawBefore, expectAbsent === true);
        abortCheck(signal);
        // Phase 6 — commit.
        await commitTempFile(tempPath, target.targetPath);
        tempPath = undefined;
        fileCommitted = true;
      } catch (error: unknown) {
        // Failures with their own codes pass through untouched; anything
        // else from the atomic-replacement phase is an unexpected safe-
        // replacement failure (spec §45) — never a silent non-atomic
        // fallback.
        if (error instanceof Error && /E_(FILE_CHANGED|PATH_CHANGED|ABORTED|FILE_TOO_LARGE)/.test(error.message)) {
          throw error;
        }
        throw new Error(
          `[E_ATOMIC_REPLACE_FAILED] The safe atomic replacement of ${label} failed: ${error instanceof Error ? error.message : String(error)}. Nothing was modified.`,
        );
      }
    }

    // Phase 7 — finalize state. Not abortable after commit (spec §47).
    const snapshot: FileSnapshot = {
      path: realPath,
      rawChecksum: checksumAfter,
      lineCount: docAfter.lines.length,
      anchors: anchorsAfter,
      fingerprints: fingerprintsAfter,
      retired: retiredAfter,
      updatedAt: Date.now(),
    };
    finalizeTransaction({
      snapshot,
      undoPayload: keepUndo ? undoPayload : null,
      pendingTransactionId: transactionId,
    });
  } catch (error: unknown) {
    if (tempPath) {
      await removeTempFile(tempPath);
    }
    if (!fileCommitted) {
      try {
        withBusyRetry(() =>
          requireStore()
            .db.prepare(`DELETE FROM pending_transactions WHERE transaction_id = ?`)
            .run(transactionId),
        );
      } catch {}
      throw error;
    }
    // File committed but state finalization failed: leave the pending row
    // so startup recovery can promote the after-state (§31).
    throw new Error(
      `[E_STATE_CORRUPT] The file was committed but persistent state finalization failed: ${error instanceof Error ? error.message : String(error)}. Nothing was lost; startup recovery will finalize the transaction.`,
    );
  }
}

function abortCheck(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("[E_ABORTED] Operation cancelled before commit.");
}

/** Anchor-space pressure warning (spec §52). */
export function anchorSpaceWarning(
  activeCount: number,
  retiredCount: number,
): string | undefined {
  const used = activeCount + retiredCount;
  if (used / ANCHOR_SPACE > ANCHOR_SPACE_PRESSURE_RATIO) {
    return `[W_ANCHOR_SPACE_PRESSURE] ${used} of ${ANCHOR_SPACE} anchor values are in use for this file.`;
  }
  return undefined;
}

export function mixedEndingsWarning(
  docBefore: Document,
  addedLines: number,
): string | undefined {
  if (addedLines > 0 && hasMixedLineEndings(docBefore.lines)) {
    return `[W_MIXED_LINE_ENDINGS] The file has mixed line endings; newly inserted lines use the dominant ending. Untouched lines were not normalized.`;
  }
  return undefined;
}

export function encodeAfterBytes(doc: Document): Buffer {
  return Buffer.from(encodeDocument(doc), "utf-8");
}

export function textsOf(lines: TextLine[]): string[] {
  return lines.map((line) => line.text);
}

export function newTransactionIdFor(): string {
  return newTransactionId();
}

export type { FinalNewline };
