/**
 * `edit` tool (spec §13–§22, PH-PROTO-001..003, PH-EDIT-001..008,
 * PH-CONCURRENCY-001..003).
 *
 * Performs one or more range replacements atomically within one file. All
 * ranges resolve against the same original document; every line of every
 * destructive range must have been served and still match; overlapping
 * ranges are rejected; the transaction commits once and returns one
 * combined anchored diff.
 *
 * Before commit, two safety preflights run (PH-EDIT-001, PH-EDIT-006):
 * boundary-duplicate detection rejects `E_BOUNDARY_DUP` by default, and the
 * large-destructive guard rejects `E_LARGE_DESTRUCTIVE_EDIT`. Both have
 * explicit top-level escape hatches and never authorize an edit on their own.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { HASHLINE_PROTOCOL_ID } from "../integration/protocol";
import { Type } from "typebox";
import { toCwd } from "../paths";
import { abortIf, debugLog, sha256Hex } from "../utils";
import { withFileMutationQueue } from "../filesystem/concurrency";
import { resolveTarget } from "../filesystem/resolve-target";
import { getLargeEditGuard } from "../constants";
import {
  validateEditRequest,
  type EditRequest,
} from "../mutation/validate";
import {
  buildAnchorIndex,
  resolveAnchor,
  staleAnchorMessage,
  reversedRangeMessage,
} from "../mutation/resolve";
import {
  applyTransaction,
  type EditOp,
} from "../mutation/apply";
import {
  loadAnchoredFile,
  commitMutation,
  encodeAfterBytes,
  anchorSpaceWarning,
  mixedEndingsWarning,
  newTransactionIdFor,
} from "../mutation/transaction";
import { checkRangeServed, formatRangeFailure } from "../served/authorize";
import { renderDiff } from "../render/diff";
import { serveLines, servedWindowNotice } from "../served/ledger";
import {
  detectBoundaryDuplication,
  boundaryDupRejection,
  boundaryDupWarning,
  computePostTransactionTexts,
  isLargeDestructiveChange,
  largeDestructiveRejection,
} from "../render/warnings";
import { hashlineDetails } from "../render/result-details";
import { isFrozen, frozenRejection } from "../integration/freeze";
import {
  emitMutationBefore,
  emitMutationAfter,
  emitMutationRejected,
  mutationEventBase,
} from "../integration/ipc";
import { fingerprintHexes } from "../anchors/fingerprints";
import type { MutationMetrics } from "./mutation-types";
export type { MutationMetrics } from "./mutation-types";

export interface EditToolDetails {
  diff?: string;
  metrics: MutationMetrics;
  hashline: ReturnType<typeof hashlineDetails>;
}

// Authoritative checks in src/mutation/validate.ts
const editSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to edit" }),
    edits: Type.Array(
      Type.Object(
        {
          range: Type.Array(Type.String({ pattern: "^[A-Za-z0-9]{4}$" }), {
            minItems: 2,
            maxItems: 2,
            description:
              "Exactly two anchors [start, end], both inclusive. Use the same anchor twice for a single-line replacement.",
          }),
          lines: Type.Array(Type.String(), {
            description:
              "Literal logical output lines replacing the range. Use [] to delete.",
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    allow_display_like_content: Type.Optional(
      Type.Boolean({
        description:
          "When true, write replacement lines that look like hashline tool output literally instead of rejecting them.",
      }),
    ),
    allow_boundary_duplicate: Type.Optional(
      Type.Boolean({
        description:
          "When true, permit a replacement that duplicates the unchanged block immediately before/after the range (E_BOUNDARY_DUP is suppressed).",
      }),
    ),
    allow_large_change: Type.Optional(
      Type.Boolean({
        description:
          "When true, permit an unusually destructive replacement (E_LARGE_DESTRUCTIVE_EDIT is suppressed).",
      }),
    ),
    final_newline: Type.Optional(
      Type.Union([
        Type.Literal("preserve"),
        Type.Literal("present"),
        Type.Literal("absent"),
      ]),
    ),
    expected_revision: Type.Optional(
      Type.String({
        description:
          "When provided, the whole-file CAS mode: the edit fails if the current revision differs.",
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

const E_DESC = `Protocol-ID: ${HASHLINE_PROTOCOL_ID} (anchor width 4). Replace one or more anchored line ranges in a single file, atomically. Ranges reference the 4-character anchors returned by read/grep/diff output. Every line in every range must have been shown to you in this session with exactly the content it has now; otherwise the whole call fails and nothing is modified. Multiple ranges are validated together and committed as one transaction.`;

const E_SNIPPET =
  "edit: replace anchored ranges in one file; all ranges must be fully shown and exact; ranges must not overlap; nothing is applied unless every edit validates.";

const E_GUIDELINES = [
  "Only use anchors that were returned to you (read, grep, or the diff of a previous mutation). Never invent or guess anchors.",
  "Replacement lines are literal: never include rendered `ANCHOR│` prefixes or diff `+`/`-` markers. Such content is rejected, not stripped.",
  "Ranges are inclusive and resolved against the same pre-edit file; overlapping ranges (even sharing one endpoint line) are rejected.",
  "Review the anchored diff after every successful edit before making dependent edits.",
];

export function buildEditToolDef(): ToolDefinition<any, EditToolDetails> {
  return {
    name: "edit",
    label: "Edit",
    description: E_DESC,
    promptSnippet: E_SNIPPET,
    promptGuidelines: E_GUIDELINES,
    parameters: editSchema,
    executionMode: "sequential",

    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const request = validateEditRequest(params);
      const absolutePath = toCwd(request.path, ctx.cwd);
      const mutationTargetPath = await resolveTarget(absolutePath);
      const rejectionTxId = newTransactionIdFor();
      let beforeSha = "";
      try {
        return await runEdit({
          toolCallId,
          request,
          mutationTargetPath,
          signal,
          trackBeforeSha: (sha) => {
            beforeSha = sha;
          },
        });
      } catch (error) {
        // §31.11: report structured rejections without depending on a reply.
        const message = error instanceof Error ? error.message : String(error);
        const code = /\[(E_[A-Z0-9_]+)\]/.exec(message)?.[1] ?? "E_UNKNOWN";
        emitMutationRejected(
          mutationEventBase({
            transactionId: rejectionTxId,
            toolCallId,
            path: mutationTargetPath,
            operation: "edit",
            editCount: request.edits.length,
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

interface RunEditInput {
  toolCallId: string;
  request: EditRequest;
  mutationTargetPath: string;
  signal?: AbortSignal;
  trackBeforeSha: (sha: string) => void;
}

async function runEdit(input: RunEditInput): Promise<ReturnType<ToolDefinition<any, EditToolDetails>["execute"]>> {
  const { toolCallId, request, mutationTargetPath, signal, trackBeforeSha } = input;
  return withFileMutationQueue(mutationTargetPath, async () => {
    // PH §12.5: destructive tools reject while a Sentinel freeze is active.
    if (isFrozen()) {
      throw new Error(frozenRejection("edit"));
    }
    abortIf(signal);
    const file = await loadAnchoredFile(mutationTargetPath, request.path);
    trackBeforeSha(file.checksum);
    const anchorIndex = buildAnchorIndex(file.anchors);

    const ops: EditOp[] = [];
    for (let i = 0; i < request.edits.length; i++) {
      const item = request.edits[i]!;
      const startAnchor = item.range[0];
      const endAnchor = item.range[1];
      const start = resolveAnchor(anchorIndex, startAnchor);
      const end = resolveAnchor(anchorIndex, endAnchor);
      if (start === undefined) {
        throw new Error(
          staleAnchorMessage(
            mutationTargetPath,
            startAnchor,
            file.anchors,
            file.texts,
            end,
          ),
        );
      }
      if (end === undefined) {
        throw new Error(
          staleAnchorMessage(
            mutationTargetPath,
            endAnchor,
            file.anchors,
            file.texts,
            start,
          ),
        );
      }
      if (start > end) {
        throw new Error(
          reversedRangeMessage(request.path, startAnchor, endAnchor),
        );
      }
      ops.push({ kind: "edit", start, end, lines: item.lines, requestIndex: i });
    }

    // Served-range authorization (spec §10, PH-CONTEXT-003).
    for (const op of ops) {
      const check = checkRangeServed(
        mutationTargetPath,
        file.anchors,
        file.texts,
        op.start,
        op.end,
      );
      if (!check.ok) {
        throw new Error(
          formatRangeFailure(
            request.path,
            mutationTargetPath,
            file.anchors,
            file.texts,
            op.start,
            op.end,
            check,
          ),
        );
      }
    }

    abortIf(signal);
    const result = applyTransaction(
      file.doc,
      { anchors: file.anchors, retired: file.retired },
      ops,
      { finalNewline: request.final_newline },
    );

    const beforeRevision = file.checksum;
    const transactionId = newTransactionIdFor();

    const warnings: string[] = [];
    if (result.unusedFinalNewline) {
      warnings.push(
        `[W_UNUSED_OPTION] "final_newline" was specified but no edit reaches the end of the file; it was not applied.`,
      );
    }
    const retiredAfter = new Set([...file.retired, ...result.retiredAdded]);
    const pressure = anchorSpaceWarning(new Set(result.anchors).size, retiredAfter.size);
    if (pressure) warnings.push(pressure);
    const mixed = mixedEndingsWarning(file.doc, result.metrics.linesAdded);
    if (mixed) warnings.push(mixed);

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

    // ── Safety preflights (run before commit; PH-EDIT-001/006) ─────────
    const sortedOps = [...ops].sort((a, b) => a.start - b.start);
    const removedTotal = result.metrics.linesRemoved;
    const addedTotal = result.metrics.linesAdded;

    // Large destructive guard (PH-EDIT-006..008), per edit for a precise
    // operation index (§31.10).
    if (request.allow_large_change !== true) {
      for (const op of sortedOps) {
        const removed = op.end - op.start + 1;
        const added = op.lines.length;
        const guard = getLargeEditGuard();
        if (isLargeDestructiveChange(removed, added, guard)) {
          throw new Error(
            largeDestructiveRejection(request.path, removed, added, guard),
          );
        }
      }
    }

    // Boundary-duplicate detection (PH-EDIT-001..005) against the lines
    // that will be adjacent AFTER the whole transaction applies.
    const { texts: postTexts, insertPositions } = computePostTransactionTexts(
      file.texts,
      sortedOps,
    );
    const boundaryFindings: Array<{ requestIndex: number; findings: ReturnType<typeof detectBoundaryDuplication> }> = [];
    for (let i = 0; i < sortedOps.length; i++) {
      const op = sortedOps[i]!;
      const pos = insertPositions[i]!;
      const before = postTexts.slice(0, pos);
      const after = postTexts.slice(pos + op.lines.length);
      const findings = detectBoundaryDuplication(op.lines, before, after);
      if (findings.length > 0) {
        boundaryFindings.push({ requestIndex: op.requestIndex, findings });
      }
    }
    if (boundaryFindings.length > 0) {
      if (request.allow_boundary_duplicate !== true) {
        const first = boundaryFindings[0]!;
        throw new Error(
          boundaryDupRejection(request.path, first.requestIndex, first.findings),
        );
      }
      // Escape hatch used: apply literally but flag it for review (§55).
      for (const { requestIndex, findings } of boundaryFindings) {
        warnings.push(boundaryDupWarning(request.path, requestIndex, findings));
      }
    }

    const afterRaw = encodeAfterBytes(result.document);
    const afterChecksum = sha256Hex(afterRaw);

    emitMutationBefore(
      mutationEventBase({
        transactionId,
        toolCallId,
        path: mutationTargetPath,
        operation: "edit",
        editCount: ops.length,
        removedLines: removedTotal,
        addedLines: addedTotal,
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

    const diff = renderDiff(result.diffRows);
    const evictedRows = serveLines(mutationTargetPath, diff.served);
    let diffText = diff.text;
    if (evictedRows > 0) diffText += servedWindowNotice(evictedRows);
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
    const text = warnings.length > 0 ? `${diffText}\n\n${warnings.join("\n")}` : diffText;
    emitMutationAfter(
      mutationEventBase({
        transactionId,
        toolCallId,
        path: mutationTargetPath,
        operation: "edit",
        editCount: ops.length,
        removedLines: removedTotal,
        addedLines: addedTotal,
        beforeSha256: beforeRevision,
        afterSha256: afterChecksum,
        outcome: "success",
        warningCodes: warnings
          .map((w) => /^\[(W_[A-Z0-9_]+)\]/.exec(w)?.[1])
          .filter((c): c is string => Boolean(c)),
      }),
    );
    debugLog("edit committed", { path: mutationTargetPath, metrics, warnings });

    return {
      content: [{ type: "text", text }],
      details: {
        diff: diffText,
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
