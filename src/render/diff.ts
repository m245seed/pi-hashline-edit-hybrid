/**
 * Anchored diff rendering (spec §26, PH-OUTPUT-001..007).
 *
 * A successful transaction returns an anchored diff: `" "` rows are current
 * unchanged lines, `"+"` rows are current new lines, and `"-"` rows are
 * deleted historical lines — not current editable lines, so they are never
 * served. The diff can immediately seed a follow-up edit.
 *
 * Rendering is bounded (PH-OUTPUT-003): each row is subject to the per-line
 * display limit and the whole diff to a total byte budget. A current row
 * that is omitted — oversized or cut by the budget — MUST NOT authorize
 * further edits (PH-OUTPUT-007): it is replaced by a notice carrying no
 * anchor and never enters the served ledger. Truncation happens only
 * between complete rows (PH-OUTPUT-004).
 */

import { HASH_SEP } from "../anchors/alphabet";
import { DIFF_MAX_OUTPUT_BYTES, MAX_DISPLAY_LINE_BYTES } from "../constants";
import { formatSize } from "../utils";
import { serveLines } from "../served/ledger";
import { applyOutputBudget, type CandidateRow } from "./budget";
import type { DiffRow } from "../mutation/apply";

export interface RenderedDiff {
  text: string;
  /** Complete exact current rows retained in the output. */
  served: Array<{ anchor: string; exactText: string; lineIndex?: number }>;
  servedRows: number;
  truncated: boolean;
}

export function formatDiffRow(row: DiffRow): string {
  if (row.anchor === "") {
    return `${row.prefix} ${HASH_SEP}${row.text}`;
  }
  return `${row.prefix}${row.anchor}${HASH_SEP}${row.text}`;
}

function omittedCurrentRow(bytes: number): string {
  return `[current diff row omitted: ${formatSize(bytes)}. The row is too large to display and is not authorized for further edits; inspect it with a targeted workflow.]`;
}

function omittedRemovedRow(bytes: number): string {
  return `[removed diff row omitted: ${formatSize(bytes)}]`;
}

export function renderDiff(path: string, rows: DiffRow[]): RenderedDiff {
  const candidates: CandidateRow[] = [];
  for (const row of rows) {
    const bytes = Buffer.byteLength(row.text, "utf-8");
    if (row.prefix === "-") {
      // Historical rows are never served; oversized ones are summarized.
      if (bytes > MAX_DISPLAY_LINE_BYTES) {
        candidates.push({ rendered: omittedRemovedRow(bytes) });
      } else {
        candidates.push({ rendered: formatDiffRow(row) });
      }
      continue;
    }
    if (row.anchor === "") {
      // Structural rows (ellipsis markers) carry no content.
      candidates.push({ rendered: formatDiffRow(row) });
      continue;
    }
    if (bytes > MAX_DISPLAY_LINE_BYTES) {
      // PH-OUTPUT-007: an omitted current row must not become servable.
      candidates.push({ rendered: omittedCurrentRow(bytes) });
      continue;
    }
    candidates.push({
      rendered: formatDiffRow(row),
      servable: { anchor: row.anchor, exactText: row.text },
    });
  }

  const budgeted = applyOutputBudget(candidates, DIFF_MAX_OUTPUT_BYTES);
  const output = budgeted.rows.slice();
  if (budgeted.truncated) {
    output.push(
      `[diff output truncated: ${budgeted.dropped} more row(s) were omitted to stay within the ${formatSize(DIFF_MAX_OUTPUT_BYTES)} output budget. Omitted rows are not authorized for edits; use read to view them.]`,
    );
  }
  serveLines(path, budgeted.served);
  return {
    text: output.join("\n"),
    served: budgeted.served,
    servedRows: budgeted.served.length,
    truncated: budgeted.truncated,
  };
}
