/**
 * Hashline rendering (spec §12, §25, PH-OUTPUT-001..006).
 *
 * Rows are `anchor│text`. Long lines (above the display limit) are replaced
 * by an omission row that exposes NO editable anchor and is NOT served —
 * the model must not assume authorization for content it never received.
 *
 * All rendering funnels through the single bounded output engine
 * (PH-OUTPUT-001): per-line limits plus a total byte budget, truncation only
 * between complete rows, and serving only for rows retained in full.
 */

import { HASH_SEP } from "../anchors/alphabet";
import { MAX_DISPLAY_LINE_BYTES, READ_MAX_OUTPUT_BYTES } from "../constants";
import { formatSize } from "../utils";
import { serveLines } from "../served/ledger";
import { applyOutputBudget, type CandidateRow } from "./budget";

export interface DisplayRow {
  anchor: string;
  text: string;
  served: boolean;
}

export function formatDisplayRow(anchor: string, text: string): string {
  return `${anchor}${HASH_SEP}${text}`;
}

export function omittedRow(lineNumber: number, bytes: number): string {
  return `[Line ${lineNumber} omitted: ${formatSize(bytes)}. [E_LINE_TOO_LARGE] Use read with an appropriate inspection workflow.]`;
}

/**
 * Render document lines 0-based [start, end) WITHOUT serving them. Use when
 * the rendered rows may still be truncated or dropped downstream; serve the
 * surviving rows explicitly via serveLines so the ledger only ever contains
 * complete rows the model actually received.
 */
export function renderLinesUnserved(
  anchors: readonly string[],
  texts: readonly string[],
  startLine: number,
  endLine: number,
): { rows: string[]; served: Array<{ anchor: string; exactText: string }> } {
  const rows: string[] = [];
  const served: Array<{ anchor: string; exactText: string }> = [];
  for (let line = startLine; line < endLine; line++) {
    const anchor = anchors[line]!;
    const text = texts[line]!;
    const bytes = Buffer.byteLength(text, "utf-8");
    if (bytes > MAX_DISPLAY_LINE_BYTES) {
      rows.push(omittedRow(line + 1, bytes));
      continue;
    }
    rows.push(formatDisplayRow(anchor, text));
    served.push({ anchor, exactText: text });
  }
  return { rows, served };
}

export interface BoundedRender {
  /** Rendered text of retained rows. */
  text: string;
  /** Complete exact rows retained — the only rows served. */
  served: Array<{ anchor: string; exactText: string }>;
  /** 0-based index of the first line NOT rendered (== endLine when none dropped). */
  nextLine: number;
  /** True when the byte budget dropped at least one row. */
  truncated: boolean;
}

/**
 * Render document lines 0-based [start, end) under the total read output
 * budget (PH-OUTPUT-003). Oversized lines become omission notices; the byte
 * budget truncates between complete rows. Only retained complete rows are
 * served (PH-OUTPUT-002/005). Returns continuation info (PH-OUTPUT-006).
 */
export function renderLinesBounded(
  anchors: readonly string[],
  texts: readonly string[],
  startLine: number,
  endLine: number,
  maxTotalBytes: number = READ_MAX_OUTPUT_BYTES,
): BoundedRender {
  const candidates: CandidateRow[] = [];
  for (let line = startLine; line < endLine; line++) {
    const anchor = anchors[line]!;
    const text = texts[line]!;
    const bytes = Buffer.byteLength(text, "utf-8");
    if (bytes > MAX_DISPLAY_LINE_BYTES) {
      candidates.push({ rendered: omittedRow(line + 1, bytes) });
      continue;
    }
    candidates.push({
      rendered: formatDisplayRow(anchor, text),
      servable: { anchor, exactText: text, lineIndex: line },
    });
  }
  const budgeted = applyOutputBudget(candidates, maxTotalBytes);
  // Candidates are 1:1 with source lines, and truncation keeps a prefix, so
  // continuation resumes right after the last retained row (PH-OUTPUT-006).
  const nextLine = budgeted.truncated ? startLine + budgeted.rows.length : endLine;
  return {
    text: budgeted.rows.join("\n"),
    served: budgeted.served.map(({ anchor, exactText }) => ({ anchor, exactText })),
    nextLine,
    truncated: budgeted.truncated,
  };
}

/**
 * Render document lines 0-based [start, end) as hashline rows, omitting
 * oversized lines. Line numbers in omission notices are absolute and
 * 1-based. Returns the rendered text and the served entries (complete
 * rows only), and serves them.
 */
export function renderLines(
  path: string,
  anchors: readonly string[],
  texts: readonly string[],
  startLine: number,
  endLine: number,
): { text: string; served: Array<{ anchor: string; exactText: string }> } {
  const { rows, served } = renderLinesUnserved(anchors, texts, startLine, endLine);
  serveLines(path, served);
  return { text: rows.join("\n"), served };
}
