/**
 * `insert` tool (spec §23, PH-PROTO-001..003, PH-CONCURRENCY-001..003).
 *
 * Insertion stays separate from replacement. Each insert adds lines before
 * or after a single anchor line; the anchor line itself must have been
 * served and must still match. Multiple insertions in one call are
 * transactional; same anchor + direction keep request order.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toCwd } from "../paths";
import { abortIf, sha256Hex } from "../utils";
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
import { servedEntry, serveLines, isStale } from "../served/ledger";
import { getContextEpoch } from "../served/epoch";
import { formatDisplayRow } from "../render/hashline";
import { renderDiff } from "../render/diff";
import { hashlineDetails } from "../render/result-details";
import { isFrozen, frozenRejection } from "../integration/freeze";
import {
  emitMutationBefore,
  emitMutationAfter,
  emitMutationRejected,
  mutationEventBase,
} from "../integration/ipc";
import { fingerprintHexes } from "../anchors/fingerprints";
import { MAX_FEEDBACK_LINES, MAX_DISPLAY_LINE_BYTES } from "../constants";
import { formatSize } from "../utils";
import type { MutationMetrics } from "./edit";

export interface InsertToolDetails {
  diff?: string;
  metrics: MutationMetrics;
  hashline: ReturnType<typeof hashlineDetails>;
}

const insertSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to modify" }),
    inserts: Type.Array(
      Type.Object(
        {
          anchor: Type.String({
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
    $id: "pi-hashline/insert@1",
  },
);

const I_DESC = `Protocol-ID: pi-hashline/1 (anchor width 4). Insert literal lines before or after a single anchor line in one file. The anchor line itself is preserved and must have been shown to you in this session with exactly its current content. Multiple inserts in one call are validated together and committed as one transaction.`;

const I_SNIPPET =
  "insert: add lines before/after an anchored line; the anchor line must have been shown and must still match; multiple inserts commit atomically.";

const I_GUIDELINES = [
  "Only use anchors that were returned to you; never invent anchors.",
  "Inserted lines are literal: never include rendered `ANCHOR│` prefixes or diff markers.",
  "Do not repeat the anchor line's own content in `lines`.",
];

function insertAuthMessage(
  path: string,
  realPath: string,
  anchor: string,
  lineIndex: number,
  anchors: readonly string[],
  texts: readonly string[],
  stale: boolean,
): string {
  const fresh: string[] = [];
  const served: Array<{ anchor: string; exactText: string; lineIndex: number }> = [];
  const start = Math.max(0, lineIndex - 2);
  const end = Math.min(texts.length, start + MAX_FEEDBACK_LINES);
  for (let line = start; line < end; line++) {
    const text = texts[line]!;
    const bytes = Buffer.byteLength(text, "utf-8");
    if (bytes > MAX_DISPLAY_LINE_BYTES) {
      // PH-OUTPUT-008: feedback never bypasses oversized-line protections.
      fresh.push(
        `[Line ${line + 1} omitted: ${formatSize(bytes)}. Not authorized for edits.]`,
      );
      continue;
    }
    served.push({ anchor: anchors[line]!, exactText: text, lineIndex: line });
    fresh.push(formatDisplayRow(anchors[line]!, text));
  }
  serveLines(realPath, served);
  const code = stale ? "E_RANGE_STALE" : "E_ANCHOR_NOT_SERVED";
  const detail = stale
    ? `The anchor line "${anchor}" (line ${lineIndex + 1}) in ${path} no longer contains the content you saw.`
    : `The anchor line "${anchor}" (line ${lineIndex + 1}) in ${path} was not shown in this session.`;
  return `[${code}] ${detail} Nothing was modified.\n\nCurrent context with fresh anchors:\n${fresh.join("\n")}`;
}

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
    const epoch = getContextEpoch();

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
      const entry = servedEntry(mutationTargetPath, item.anchor);
      if (entry === undefined) {
        // Shown-but-changed anchors are stale, not merely unseen (§71).
        if (isStale(mutationTargetPath, item.anchor)) {
          throw new Error(
            insertAuthMessage(
              request.path,
              mutationTargetPath,
              item.anchor,
              idx,
              file.anchors,
              file.texts,
              true,
            ),
          );
        }
        throw new Error(
          insertAuthMessage(
            request.path,
            mutationTargetPath,
            item.anchor,
            idx,
            file.anchors,
            file.texts,
            false,
          ),
        );
      }
      if (entry.exactText !== file.texts[idx]) {
        throw new Error(
          insertAuthMessage(
            request.path,
            mutationTargetPath,
            item.anchor,
            idx,
            file.anchors,
            file.texts,
            true,
          ),
        );
      }
      if (entry.epoch < epoch) {
        // PH-CONTEXT-003/004: older-epoch authorization has expired.
        throw new Error(
          `[E_CONTEXT_EPOCH_STALE] The anchor line "${item.anchor}" (line ${idx + 1}) in ${request.path} was shown before the context was rebuilt; its authorization has expired. Nothing was modified. Re-read the line to re-authorize it in the current context epoch.`,
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

export function registerInsertTool(pi: ExtensionAPI): void {
  pi.registerTool(buildInsertToolDef());
}
