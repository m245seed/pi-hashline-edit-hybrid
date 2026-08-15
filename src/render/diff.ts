/**
 * Anchored diff rendering (spec §26).
 *
 * A successful transaction returns an anchored diff: `" "` rows are current
 * unchanged lines (served), `"+"` rows are current new lines (served), and
 * `"-"` rows are deleted historical lines — not current editable lines, so
 * they are never served. The diff can immediately seed a follow-up edit.
 */

import { HASH_SEP } from "../anchors/alphabet";
import { serveLines } from "../served/ledger";
import type { DiffRow } from "../mutation/apply";

export function formatDiffRow(row: DiffRow): string {
  if (row.anchor === "") {
    return `${row.prefix} ${HASH_SEP}${row.text}`;
  }
  return `${row.prefix}${row.anchor}${HASH_SEP}${row.text}`;
}

export function renderDiff(path: string, rows: DiffRow[]): string {
  const served: Array<{ anchor: string; exactText: string }> = [];
  for (const row of rows) {
    if (row.prefix === "-" || row.anchor === "") continue;
    served.push({ anchor: row.anchor, exactText: row.text });
  }
  serveLines(path, served);
  return rows.map(formatDiffRow).join("\n");
}
