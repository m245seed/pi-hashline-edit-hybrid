/**
 * Warning construction (spec §18, §55).
 *
 * Warnings never alter requested content. `W_BOUNDARY_DUP` reports that a
 * replacement ends (or starts) with content identical to the unchanged block
 * beyond the range — the request was applied literally; verify the diff.
 */

export interface BoundaryDup {
  kind: "leading" | "trailing";
  /** 0-based index into the replacement lines. */
  replacementLineIndex: number;
}

export function detectBoundaryDuplicates(
  replacementLines: string[],
  fileTexts: readonly string[],
  startLine: number,
  endLine: number,
): BoundaryDup[] {
  const dups: BoundaryDup[] = [];
  if (replacementLines.length > 0) {
    const afterEnd = fileTexts.slice(endLine + 1);
    let k = replacementLines.length - 1;
    let after = 0;
    while (k >= 0 && after < afterEnd.length && replacementLines[k] === afterEnd[after]) {
      dups.push({ kind: "trailing", replacementLineIndex: k });
      k--;
      after++;
    }
    const beforeStart = fileTexts.slice(0, startLine);
    let j = 0;
    let before = beforeStart.length - 1;
    while (j < replacementLines.length && before >= 0 && replacementLines[j] === beforeStart[before]) {
      dups.push({ kind: "leading", replacementLineIndex: j });
      j++;
      before--;
    }
  }
  return dups;
}

export function boundaryDupWarning(path: string, dups: BoundaryDup[]): string {
  const kinds = dups.map((dup) =>
    dup.kind === "trailing"
      ? `replacement ends with content identical to the unchanged block immediately after the range (replacement line ${dup.replacementLineIndex + 1})`
      : `replacement starts with content identical to the unchanged block immediately before the range (replacement line ${dup.replacementLineIndex + 1})`,
  );
  return `[W_BOUNDARY_DUP] In ${path}: ${kinds.join("; ")}. The request was applied literally; verify the diff.`;
}
