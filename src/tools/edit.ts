/**
 * `edit` tool (spec §13–§22).
 *
 * Performs one or more range replacements atomically within one file. All
 * ranges resolve against the same original document; every line of every
 * destructive range must have been served and still match; overlapping
 * ranges are rejected; the transaction commits once and returns one
 * combined anchored diff.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toCwd } from "../paths";
import { abortIf, sha256Hex } from "../utils";
import { withFileMutationQueue } from "../filesystem/concurrency";
import { resolveTarget } from "../filesystem/resolve-target";
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
import { detectBoundaryDuplicates, boundaryDupWarning } from "../render/warnings";
import { fingerprintHexes } from "../anchors/fingerprints";

export interface MutationMetrics {
  classification: "applied" | "noop";
  edits_attempted: number;
  edits_applied: number;
  edits_noop: number;
  lines_added: number;
  lines_removed: number;
  warnings: number;
  before_revision: string;
  after_revision: string;
  transaction_id: string | null;
}

export interface EditToolDetails {
  diff?: string;
  metrics: MutationMetrics;
}

const editSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to edit" }),
    edits: Type.Array(
      Type.Object(
        {
          range: Type.Array(Type.String(), {
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
  { additionalProperties: false },
);

const E_DESC = `Replace one or more anchored line ranges in a single file, atomically. Ranges reference the 4-character anchors returned by read/grep/diff output. Every line in every range must have been shown to you in this session with exactly the content it has now; otherwise the whole call fails and nothing is modified. Multiple ranges are validated together and committed as one transaction.`;

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

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const request = validateEditRequest(params);
      const absolutePath = toCwd(request.path, ctx.cwd);
      const mutationTargetPath = await resolveTarget(absolutePath);
      return withFileMutationQueue(mutationTargetPath, async () => {
        abortIf(signal);
        const file = await loadAnchoredFile(mutationTargetPath, request.path);
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

        // Served-range authorization (spec §10).
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

        const warnings: string[] = [];
        if (result.unusedFinalNewline) {
          warnings.push(
            `[W_UNUSED_OPTION] "final_newline" was specified but no edit reaches the end of the file; it was not applied.`,
          );
        }
        for (const op of ops) {
          const dups = detectBoundaryDuplicates(op.lines, file.texts, op.start, op.end);
          if (dups.length > 0) {
            warnings.push(boundaryDupWarning(request.path, dups));
          }
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

export function registerEditTool(pi: ExtensionAPI): void {
  pi.registerTool(buildEditToolDef());
}
