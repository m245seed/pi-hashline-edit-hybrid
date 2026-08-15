/**
 * Line-level document model (spec §40).
 *
 * A document is a sequence of logical lines, each carrying its own exact
 * line terminator. The final line uses `eol = ""` when the file has no
 * final newline. `text` is the exact content between terminators; trailing
 * whitespace is significant and never canonicalized (spec §4.2).
 *
 * Convention: a zero-byte file is treated as a single empty logical line
 * (`[{ text: "", eol: "" }]`) so the anchored protocol is total — the
 * model can insert content into an empty file through the same anchors.
 */

export type LineEol = "\n" | "\r\n" | "\r" | "";

export interface TextLine {
  text: string;
  eol: LineEol;
}

export interface Document {
  /** "\uFEFF" when the raw bytes started with a UTF-8 BOM, else "". */
  bom: string;
  lines: TextLine[];
}

const LINE_SPLIT_RE = /(\r\n|\n|\r)/;

export function splitTextLines(text: string): TextLine[] {
  if (text.length === 0) return [{ text: "", eol: "" }];
  const parts = text.split(LINE_SPLIT_RE);
  if (text.endsWith("\n") || text.endsWith("\r")) {
    parts.pop();
  }
  const lines: TextLine[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const content = parts[i] ?? "";
    const eol = (parts[i + 1] as LineEol | undefined) ?? "";
    lines.push({ text: content, eol });
  }
  return lines;
}

export function joinTextLines(lines: TextLine[]): string {
  let out = "";
  for (const line of lines) {
    out += line.text;
    out += line.eol;
  }
  return out;
}

/** Preferred eol for newly inserted lines (spec §40): dominant, tie -> first observed, default \n. */
export function preferredEol(lines: TextLine[]): LineEol {
  const counts = new Map<LineEol, number>();
  const firstSeen = new Map<LineEol, number>();
  let order = 0;
  for (const line of lines) {
    if (line.eol === "") continue;
    if (!counts.has(line.eol)) {
      counts.set(line.eol, 0);
      firstSeen.set(line.eol, order);
      order++;
    }
    counts.set(line.eol, (counts.get(line.eol) ?? 0) + 1);
  }
  let best: LineEol = "\n";
  let bestCount = 0;
  let bestOrder = Number.POSITIVE_INFINITY;
  for (const [eol, count] of counts) {
    const seen = firstSeen.get(eol) ?? 0;
    if (count > bestCount || (count === bestCount && seen < bestOrder)) {
      best = eol;
      bestCount = count;
      bestOrder = seen;
    }
  }
  return best;
}

export function hasMixedLineEndings(lines: TextLine[]): boolean {
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.eol !== "") seen.add(line.eol);
    if (seen.size > 1) return true;
  }
  return false;
}
