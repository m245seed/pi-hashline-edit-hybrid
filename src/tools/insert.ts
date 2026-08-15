/**
 * `insert` tool (spec §23).
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
import { servedText, serveLines, isStale } from "../served/ledger";
import { formatDisplayRow } from "../render/hashline";
import { renderDiff } from "../render/diff";
import { fingerprintHexes } from "../anchors/fingerprints";
import { MAX_FEEDBACK_LINES } from "../constants";
import type { MutationMetrics } from "./edit";

export interface InsertToolDetails {
  diff?: string;
  metrics: MutationMetrics;
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
  { additionalProperties: false },
);

const I_DESC = `Insert literal lines before or after a single anchor line in one file. The anchor line itself is preserved and must have been shown to you in this session with exactly its current content. Multiple inserts in one call are validated together and committed as one transaction.`;

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
  const served: Array<{ anchor: string; exactText: string }> = [];
  const start = Math.max(0, lineIndex - 2);
  const end = Math.min(texts.length, start + MAX_FEEDBACK_LINES);
  for (let line = start; line < end; line++) {
    served.push({ anchor: anchors[line]!, exactText: texts[line]! });
    fresh.push(formatDisplayRow(anchors[line]!, texts[line]!));
  }
  serveLines(realPath, served);
  const code = stale ? "E_RANGE_STALE" : "E_RANGE_UNSERVED";
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

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const request = validateInsertRequest(params);
      const absolutePath = toCwd(request.path, ctx.cwd);
      const mutationTargetPath = await resolveTarget(absolutePath);
      return withFileMutationQueue(mutationTargetPath, async () => {
        abortIf(signal);
        const file = await loadAnchoredFile(mutationTargetPath, request.path);
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
          const served = servedText(mutationTargetPath, item.anchor);
          if (served === undefined) {
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
          if (served !== file.texts[idx]) {
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
            details: { metrics },
          };
        }

        const transactionId = newTransactionIdFor();
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

        const diffText = renderDiff(mutationTargetPath, result.diffRows);
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
        return {
          content: [{ type: "text", text }],
          details: { diff: diffText, metrics },
        };
      });
    },
  };
}

export function registerInsertTool(pi: ExtensionAPI): void {
  pi.registerTool(buildInsertToolDef());
}
