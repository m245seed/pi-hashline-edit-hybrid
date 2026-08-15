/**
 * Range authorization (spec §10, §60 invariants A & B).
 *
 * To destructively modify a range, every current line in the range must have
 * been fully served during this session AND must still contain exactly the
 * content the model saw. The two failures are reported distinctly:
 *
 * - E_RANGE_UNSERVED: at least one line was never shown.
 * - E_RANGE_STALE: a previously shown line no longer matches.
 *
 * Both reject the whole transaction; the response includes a bounded fresh
 * anchored view of the affected range, and those rows become served so
 * retries are efficient.
 */

import { MAX_FEEDBACK_LINES } from "../constants";
import { HASH_SEP } from "../anchors/alphabet";
import { servedText, serveLines, isStale } from "./ledger";

export interface RangeCheck {
  ok: boolean;
  code: "E_RANGE_UNSERVED" | "E_RANGE_STALE" | null;
  /** 0-based line indexes that failed, first group (unserved, then stale). */
  unserved: number[];
  stale: number[];
}

export function checkRangeServed(
  path: string,
  anchors: readonly string[],
  texts: readonly string[],
  startLine: number,
  endLine: number,
): RangeCheck {
  const unserved: number[] = [];
  const stale: number[] = [];
  for (let line = startLine; line <= endLine; line++) {
    const anchor = anchors[line]!;
    const text = texts[line]!;
    const served = servedText(path, anchor);
    if (served === undefined) {
      // A line that was shown and then changed externally is stale, not
      // merely unseen (spec §71).
      if (isStale(path, anchor)) {
        stale.push(line);
      } else {
        unserved.push(line);
      }
    } else if (served !== text) {
      stale.push(line);
    }
  }
  if (unserved.length === 0 && stale.length === 0) {
    return { ok: true, code: null, unserved, stale };
  }
  return {
    ok: false,
    code: stale.length > 0 ? "E_RANGE_STALE" : "E_RANGE_UNSERVED",
    unserved,
    stale,
  };
}

/**
 * Build the bounded fresh anchored view for a failed range and serve the
 * rows (spec §10: "Those returned lines then become served").
 */
export function feedbackRange(
  path: string,
  anchors: readonly string[],
  texts: readonly string[],
  startLine: number,
  endLine: number,
): string {
  const total = endLine - startLine + 1;
  const shown = Math.min(total, MAX_FEEDBACK_LINES);
  const rows: string[] = [];
  const served: Array<{ anchor: string; exactText: string }> = [];
  for (let line = startLine; line < startLine + shown; line++) {
    const anchor = anchors[line]!;
    const text = texts[line]!;
    served.push({ anchor, exactText: text });
    rows.push(`${anchor}${HASH_SEP}${text}`);
  }
  serveLines(path, served);
  const capHint =
    total > shown
      ? `\n\n[The range has ${total} lines; showing the first ${shown}. Use read with offset=${startLine + shown + 1} to see the rest.]`
      : "";
  return `${rows.join("\n")}${capHint}`;
}

export function formatRangeFailure(
  displayPath: string,
  ledgerPath: string,
  anchors: readonly string[],
  texts: readonly string[],
  startLine: number,
  endLine: number,
  check: RangeCheck,
): string {
  const total = endLine - startLine + 1;
  const location = ` in ${displayPath}`;
  if (check.code === "E_RANGE_UNSERVED") {
    const count = check.unserved.length;
    const first = check.unserved[0]!;
    const detail =
      count === 1
        ? `Line ${first + 1} of the requested range (lines ${startLine + 1}-${endLine + 1})${location} was not shown in this session.`
        : `${count} of ${total} line(s) inside the requested destructive range (lines ${startLine + 1}-${endLine + 1})${location} were not shown in this session.`;
    return `[E_RANGE_UNSERVED] ${detail} Nothing was modified.\n\nCurrent range with fresh anchors:\n${feedbackRange(ledgerPath, anchors, texts, startLine, endLine)}`;
  }
  const count = check.stale.length;
  const first = check.stale[0]!;
  const detail =
    count === 1
      ? `Line ${first + 1} of the requested range (lines ${startLine + 1}-${endLine + 1})${location} differs from what was shown.`
      : `${count} of ${total} line(s) in the requested range (lines ${startLine + 1}-${endLine + 1})${location} differ from what was shown.`;
  return `[E_RANGE_STALE] ${detail} The file changed on disk after the anchors were read. Nothing was modified.\n\nCurrent range with fresh anchors:\n${feedbackRange(ledgerPath, anchors, texts, startLine, endLine)}`;
}
