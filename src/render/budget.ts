/**
 * Single bounded output engine (PH-OUTPUT-001..006).
 *
 * All read, grep, diff, write-preview, and error-feedback rendering funnels
 * through this budget so the render-then-serve invariant holds everywhere:
 *
 * - per-line limits are applied upstream (oversized lines become omission
 *   notices that carry no anchor and are never servable);
 * - the total byte budget truncates only between complete rows;
 * - a row becomes served only when it is retained as a complete exact row in
 *   the final tool result — rows omitted by a budget never enter the served
 *   ledger (PH-OUTPUT-005).
 */

export interface CandidateRow {
  /** The exact rendered row text for output. */
  rendered: string;
  /** Precomputed byte length of rendered (without trailing delimiter). */
  renderedBytes?: number;
  /**
   * Present only when the row is a complete exact file row that may enter
   * the served ledger once retained. Omission notices and structural rows
   * carry no servable entry.
   */
  servable?: {
    anchor: string;
    exactText: string;
    lineIndex?: number;
    path?: string;
  };
}

export interface BudgetedOutput {
  /** Retained rendered rows, in order. */
  rows: string[];
  /** Complete exact rows retained — the only rows that may be served. */
  served: Array<{
    anchor: string;
    exactText: string;
    lineIndex?: number;
    path?: string;
  }>;
  /** True when at least one candidate row was dropped by the byte budget. */
  truncated: boolean;
  /** Number of candidate rows dropped by the byte budget. */
  dropped: number;
}

/**
 * Retain candidate rows while they fit the total byte budget. Truncation
 * happens only between complete rows (PH-OUTPUT-004): the first row that
 * does not fit ends the output, and every later row is dropped with it —
 * rows are never sliced and never reordered.
 */
export function applyOutputBudget(
  candidates: readonly CandidateRow[],
  maxTotalBytes: number,
): BudgetedOutput {
  const rows: string[] = [];
  const served: BudgetedOutput["served"] = [];
  let budget = maxTotalBytes;
  let dropped = 0;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const bytes =
      (candidate.renderedBytes ?? Buffer.byteLength(candidate.rendered, "utf-8")) + 1;
    if (bytes > budget) {
      dropped = candidates.length - i;
      break;
    }
    budget -= bytes;
    rows.push(candidate.rendered);
    if (candidate.servable) served.push(candidate.servable);
  }
  return { rows, served, truncated: dropped > 0, dropped };
}
