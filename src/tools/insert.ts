/**
 * `insert` tool (spec §23, PH-PROTO-001..003, PH-CONCURRENCY-001..003).
 *
 * Insertion stays separate from replacement. Each insert adds lines before
 * or after a single anchor line; the anchor line itself must have been
 * served and must still match. Multiple insertions in one call are
 * transactional; same anchor + direction keep request order.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toCwd } from "../paths";
import { abortIf, debugLog, sha256Hex } from "../utils";
import { withFileMutationQueue } from "../filesystem/concurrency";
import { resolveTarget } from "../filesystem/resolve-target";
import { validateInsertRequest } from "../mutation/validate";
import {
  buildAnchorIndex,
  resolveAnchor,
  staleAnchorMessage,
} from "../mutation/resolve";
import {
  applyTransaction,
  type InsertOp,
} from "../mutation/apply";
import {
  loadAnchoredFile,
  commitMutation,
  encodeAfterBytes,
  anchorSpaceWarning,
  mixedEndingsWarning,
  newTransactionIdFor,
} from "../mutation/transaction";
import { renderDiff } from "../render/diff";
import { hashlineDetails } from "../render/result-details";
import { isFrozen, frozenRejection } from "../integration/freeze";
import {
  emitMutationBefore,
  emitMutationAfter,
  emitMutationRejected,
  mutationEventBase,
} from "../integration/ipc";
import { HASHLINE_PROTOCOL_ID } from "../integration/protocol";
import { fingerprintHexes } from "../anchors/fingerprints";
import { MAX_FEEDBACK_LINES, MAX_DISPLAY_LINE_BYTES } from "../constants";
import { formatSize } from "../utils";
import { checkRangeServed, formatRangeFailure } from "../served/authorize";
import type { MutationMetrics } from "./mutation-types";
export interface InsertToolDetails {
  /** Rendered anchored diff text (same content as the text response);
   * omitted for no-op transactions, which produce no diff. */
  diff?: string;
  metrics: MutationMetrics;
  hashline: ReturnType<typeof hashlineDetails>;
}

// Authoritative checks in src/mutation/validate.ts
const insertSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to modify" }),
    inserts: Type.Array(
      Type.Object(
        {
          anchor: Type.String({
            pattern: "^[A-Za-z0-9]{4}$",
            description:
              "Bare 4-character anchor of the line to insert around; the anchor line itself is preserved.",
          }),
          direction: Type.Union([
            Type.Literal("before"),
            Type.Literal("after"),
          ]),
          lines: Type.Array(Type.String(), {
            description: "Literal logical lines to insert.",
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    allow_display_like_content: Type.Optional(Type.Boolean()),
    final_newline: Type.Optional(
      Type.Union([
        Type.Literal("preserve"),
        Type.Literal("present"),
        Type.Literal("absent"),
      ]),
    ),
    expected_revision: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
  },
);

const I_DESC = `Protocol-ID: ${HASHLINE_PROTOCOL_ID} (anchor width 4). Insert literal lines before or after a single anchor line in one file. The anchor line itself is preserved and must have been shown to you in this session with exactly its current content. Multiple inserts in one call are validated together and committed as one transaction.`;

const I_SNIPPET =
  "insert: add lines before/after an anchored line; the anchor line must have been shown and must still match; multiple inserts commit atomically.";

const I_GUIDELINES = [
  "Only use anchors that were returned to you; never invent anchors.",
  "Inserted lines are literal: never include rendered `ANCHOR│` prefixes or diff markers.",
  "Do not repeat the anchor line's own content in `lines`.",
];

export function buildInsertToolDef(): ToolDefinition<any, InsertToolDetails> {
  return {
    name: "insert",
    label: "Insert",
    description: I_DESC,
    promptSnippet: I_SNIPPET,
    promptGuidelines: I_GUIDELINES,
    parameters: insertSchema,
    executionMode: "sequential",

    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const request = validateInsertRequest(params);
      const absolutePath = toCwd(request.path, ctx.cwd);
      const mutationTargetPath = await resolveTarget(absolutePath);
      const rejectionTxId = newTransactionIdFor();
      let beforeSha = "";
      try {
        return await runInsert({
          toolCallId,
          request,
          mutationTargetPath,
          signal,
          trackBeforeSha: (sha) => {
            beforeSha = sha;
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = /\[(E_[A-Z0-9_]+)\]/.exec(message)?.[1] ?? "E_UNKNOWN";
        emitMutationRejected(
          mutationEventBase({
            transactionId: rejectionTxId,
            toolCallId,
            path: mutationTargetPath,
            operation: "insert",
            editCount: request.inserts.length,
            removedLines: 0,
            addedLines: 0,
            beforeSha256: beforeSha,
            outcome: code === "E_ABORTED" ? "cancelled" : "rejected",
            warningCodes: [code],
          }),
        );
        throw error;
      }
    },
  };
}

interface RunInsertInput {
  toolCallId: string;
  request: ReturnType<typeof validateInsertRequest>;
  mutationTargetPath: string;
  signal?: AbortSignal;
  trackBeforeSha: (sha: string) => void;
}

async function runInsert(input: RunInsertInput): Promise<ReturnType<ToolDefinition<any, InsertToolDetails>["execute"]>> {
  const { toolCallId, request, mutationTargetPath, signal, trackBeforeSha } = input;
  return withFileMutationQueue(mutationTargetPath, async () => {
    // PH §12.5: destructive tools reject while a Sentinel freeze is active.
    if (isFrozen()) {
      throw new Error(frozenRejection("insert"));
    }
    abortIf(signal);
    const file = await loadAnchoredFile(mutationTargetPath, request.path);
    trackBeforeSha(file.checksum);
    const anchorIndex = buildAnchorIndex(file.anchors);

    const ops: InsertOp[] = [];
    for (let i = 0; i < request.inserts.length; i++) {
      const item = request.inserts[i]!;
      const idx = resolveAnchor(anchorIndex, item.anchor);
      if (idx === undefined) {
        throw new Error(
          staleAnchorMessage(
            mutationTargetPath,
            item.anchor,
            file.anchors,
            file.texts,
          ),
        );
      }
      const check = checkRangeServed(mutationTargetPath, file.anchors, file.texts, idx, idx);
      if (!check.ok) {
        throw new Error(
          formatRangeFailure(request.path, mutationTargetPath, file.anchors, file.texts, idx, idx, check),
        );
      }
      ops.push({
        kind: "insert",
        anchorIndex: idx,
        direction: item.direction,
        lines: item.lines,
        requestIndex: i,
      });
    }

    abortIf(signal);
    const result = applyTransaction(
      file.doc,
      { anchors: file.anchors, retired: file.retired },
      ops,
      { finalNewline: request.final_newline },
    );

    const warnings: string[] = [];
    if (result.unusedFinalNewline) {
      warnings.push(
        `[W_UNUSED_OPTION] "final_newline" was specified but no insert reaches the end of the file; it was not applied.`,
      );
    }
    const retiredAfter = new Set([...file.retired, ...result.retiredAdded]);
    const pressure = anchorSpaceWarning(new Set(result.anchors).size, retiredAfter.size);
    if (pressure) warnings.push(pressure);
    const mixed = mixedEndingsWarning(file.doc, result.metrics.linesAdded);
    if (mixed) warnings.push(mixed);

    const afterRaw = encodeAfterBytes(result.document);
    const afterChecksum = sha256Hex(afterRaw);
    const beforeRevision = file.checksum;
    const transactionId = newTransactionIdFor();

    if (result.noop) {
      const metrics: MutationMetrics = {
        classification: "noop",
        edits_attempted: result.metrics.editsAttempted,
        edits_applied: 0,
        edits_noop: result.metrics.editsNoop,
        lines_added: 0,
        lines_removed: 0,
        warnings: warnings.length,
        before_revision: beforeRevision,
        after_revision: beforeRevision,
        transaction_id: null,
      };
      return {
        content: [{ type: "text", text: "No changes made." }],
        details: {
          metrics,
          hashline: hashlineDetails({
            outcome: "no_change",
            code: "NO_CHANGE",
            fileSha256: beforeRevision,
            servedRows: 0,
          }),
        },
      };
    }

    emitMutationBefore(
      mutationEventBase({
        transactionId,
        toolCallId,
        path: mutationTargetPath,
        operation: "insert",
        editCount: ops.length,
        removedLines: result.metrics.linesRemoved,
        addedLines: result.metrics.linesAdded,
        beforeSha256: beforeRevision,
        afterSha256: afterChecksum,
        outcome: "success",
        warningCodes: [],
      }),
    );

    abortIf(signal);
    await commitMutation({
      realPath: mutationTargetPath,
      label: request.path,
      rawBefore: file.raw,
      checksumBefore: beforeRevision,
      docBefore: file.doc,
      anchorsBefore: file.anchors,
      fingerprintsBefore: file.fingerprints,
      retiredBefore: file.retired,
      rawAfter: afterRaw,
      checksumAfter: afterChecksum,
      docAfter: result.document,
      anchorsAfter: result.anchors,
      fingerprintsAfter: fingerprintHexes(
        result.document.lines.map((line) => line.text),
      ),
      retiredAfter,
      transactionId,
      signal,
      expectedRevision: request.expected_revision,
      keepUndo: true,
      warnings,
    });

    const diff = renderDiff(mutationTargetPath, result.diffRows);
    const metrics: MutationMetrics = {
      classification: result.metrics.classification,
      edits_attempted: result.metrics.editsAttempted,
      edits_applied: result.metrics.editsApplied,
      edits_noop: result.metrics.editsNoop,
      lines_added: result.metrics.linesAdded,
      lines_removed: result.metrics.linesRemoved,
      warnings: warnings.length,
      before_revision: beforeRevision,
      after_revision: afterChecksum,
      transaction_id: transactionId,
    };
    const text = warnings.length > 0 ? `${diff.text}\n\n${warnings.join("\n")}` : diff.text;

    emitMutationAfter(
      mutationEventBase({
        transactionId,
        toolCallId,
        path: mutationTargetPath,
        operation: "insert",
        editCount: ops.length,
        removedLines: result.metrics.linesRemoved,
        addedLines: result.metrics.linesAdded,
        beforeSha256: beforeRevision,
        afterSha256: afterChecksum,
        outcome: "success",
        warningCodes: warnings
          .map((w) => /^\[(W_[A-Z0-9_]+)\]/.exec(w)?.[1])
          .filter((c): c is string => Boolean(c)),
      }),
    );
    debugLog("insert committed", { path: mutationTargetPath, metrics, warnings });

    return {
      content: [{ type: "text", text }],
      details: {
        diff: diff.text,
        metrics,
        hashline: hashlineDetails({
          outcome: "success",
          code: "OK",
          transactionId,
          fileSha256: afterChecksum,
          servedRows: diff.servedRows,
          warnings,
        }),
      },
    };
  });
}
