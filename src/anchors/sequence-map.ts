/**
 * Deterministic sequence alignment (spec §6.1, §7.1).
 *
 * A deterministic Myers-style diff (jsdiff `diffArrays`) aligns two line
 * sequences. Equal lines map positionally; the result is deterministic for
 * repeated lines (e.g. runs of `}`), preserves order, maximizes preservation,
 * and never maps one old line to two new lines.
 */

import * as Diff from "diff";

/**
 * Returns newIndex -> oldIndex for lines that are equal in both sequences.
 * Lines not present in the map are new (allocated fresh); old lines that are
 * not mapped are removed (retired).
 */
export function alignSequences<T>(
  oldSeq: readonly T[],
  newSeq: readonly T[],
): Map<number, number> {
  const parts = Diff.diffArrays(oldSeq as T[], newSeq as T[]);
  const mapping = new Map<number, number>();
  let oldPos = 0;
  let newPos = 0;
  for (const part of parts) {
    const count = part.value.length;
    if (part.added) {
      newPos += count;
    } else if (part.removed) {
      oldPos += count;
    } else {
      for (let i = 0; i < count; i++) {
        mapping.set(newPos + i, oldPos + i);
      }
      oldPos += count;
      newPos += count;
    }
  }
  return mapping;
}
