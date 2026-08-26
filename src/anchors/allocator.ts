/**
 * Anchor allocation (spec §51, §52).
 *
 * New lines receive anchors that are free in the target file's active set
 * and never reused from the file's retired set. The initial candidate comes
 * from a deterministic hash of the exact line content; collision resolution
 * probes with a fixed stride, so allocation is fully deterministic.
 * Collision resolution makes the hash quality unimportant for uniqueness —
 * the anchor is an address, not a security hash.
 */

import { ANCHOR_SPACE, ANCHOR_PROBE_STRIDE, anchorToIdx, idxToAnchor } from "./alphabet";
import { getH } from "./hasher";

export class AnchorAllocator {
  private readonly active: Set<number>;
  private readonly retired: Set<number>;

  constructor(active: ReadonlySet<string>, retired: ReadonlySet<string>) {
    this.active = new Set<number>();
    for (const a of active) {
      const idx = anchorToIdx(a);
      if (idx >= 0) this.active.add(idx);
    }
    this.retired = new Set<number>();
    for (const a of retired) {
      const idx = anchorToIdx(a);
      if (idx >= 0) this.retired.add(idx);
    }
  }

  /** Deterministic allocation for a line's exact text. */
  allocate(text: string): string {
    const base = getH().h32(text) % ANCHOR_SPACE;
    let idx = base;
    for (let probes = 0; probes < ANCHOR_SPACE; probes++) {
      if (!this.active.has(idx) && !this.retired.has(idx)) {
        this.active.add(idx);
        return idxToAnchor(idx);
      }
      idx = (idx + ANCHOR_PROBE_STRIDE) % ANCHOR_SPACE;
    }
    throw new Error(
      `[E_ANCHOR_SPACE_LOW] The 4-character anchor namespace is exhausted for this file. Re-read the file; if the file genuinely has more than ${ANCHOR_SPACE} distinct lines, use write or a non-line-based approach.`,
    );
  }
}
