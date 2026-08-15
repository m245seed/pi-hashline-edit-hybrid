/**
 * Hashline rendering (spec §12, §25).
 *
 * Rows are `anchor│text`. Long lines (above the display limit) are replaced
 * by an omission row that exposes NO editable anchor and is NOT served —
 * the model must not assume authorization for content it never received.
 */

import { HASH_SEP } from "../anchors/alphabet";
import { MAX_DISPLAY_LINE_BYTES } from "../constants";
import { formatSize } from "../utils";
import { serveLines } from "../served/ledger";

export interface DisplayRow {
  anchor: string;
  text: string;
  served: boolean;
}

export function formatDisplayRow(anchor: string, text: string): string {
  return `${anchor}${HASH_SEP}${text}`;
}

export function omittedRow(lineNumber: number, bytes: number): string {
  return `[Line ${lineNumber} omitted: ${formatSize(bytes)}. Use read with an appropriate inspection workflow.]`;
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
