/**
 * Overlap rules (spec §20).
 *
 * Destructive ranges that share any line are invalid — including ranges
 * that merely share an endpoint line. Adjacent ranges are valid.
 * Zero-width insertions at the same position are not overlaps; request
 * order defines output order there (spec §23).
 */

export interface Span {
  requestIndex: number;
  byteStart: number;
  byteEnd: number; // exclusive
}

/** Returns the indexes of the first overlapping pair, if any. */
export function findOverlap(sorted: Span[]): [number, number] | undefined {
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.byteStart < prev.byteEnd) {
      return [prev.requestIndex, cur.requestIndex];
    }
  }
  return undefined;
}
