/**
 * Anchor resolution (spec §10, §54, §31.10).
 *
 * References are resolved against the current document by anchor identity,
 * never by line number and never by fuzzy matching. A reference that is no
 * longer current fails with E_ANCHOR_STALE; reversed ranges fail with
 * E_RANGE_REVERSED and are never swapped automatically (spec §16).
 */

import { MAX_FEEDBACK_LINES } from "../constants";
import { renderLines } from "../render/engine";

/**
 * E_ANCHOR_STALE feedback: serve a bounded fresh anchored view so the
 * retry has current authorization, and return the formatted error message.
 * Rows are rendered through the same path as read — complete text, with
 * oversized lines omitted and unserved — so a row is served only when the
 * model actually received its full contents.
 */
export function staleAnchorMessage(
  path: string,
  anchor: string,
  anchors: readonly string[],
  texts: readonly string[],
  around?: number,
): string {
  const total = texts.length;
  let start: number;
  if (around !== undefined) {
    start = Math.max(0, Math.min(around - 2, total - 1));
  } else {
    start = 0;
  }
  const shown = Math.min(MAX_FEEDBACK_LINES, total - start);
  const { text } = renderLines(path, anchors, texts, start, start + shown);
  const location = ` in ${path}`;
  const hint = around !== undefined ? "" : "\n\nUse read() to get fresh anchors.";
  return `[E_ANCHOR_STALE] Anchor "${anchor}" is no longer current${location}: the file content changed since that anchor was read. Nothing was modified.${hint}\n\nCurrent context with fresh anchors:\n${text}`;
}

export function reversedRangeMessage(
  path: string,
  startAnchor: string,
  endAnchor: string,
): string {
  return `[E_RANGE_REVERSED] Range start occurs after range end${path ? ` in ${path}` : ""} (start anchor "${startAnchor}" is after end anchor "${endAnchor}"). Nothing was modified. The anchors were not swapped; send the range in document order.`;
}
