import { beforeEach, describe, expect, it } from "vitest";
import {
  resetServed,
  serveLine,
  servedText,
  markStale,
  isStale,
  clearServedPath,
  pruneServedPath,
  reconcileServed,
} from "../../src/served/ledger";

beforeEach(() => {
  resetServed();
});

describe("served ledger (spec §8, §9, §37)", () => {
  it("tracks stale markers", () => {
    expect(isStale("/p/f.ts", "Ab12")).toBe(false);
    markStale("/p/f.ts", "Ab12");
    expect(isStale("/p/f.ts", "Ab12")).toBe(true);
    // Per-path scoping.
    expect(isStale("/p/other.ts", "Ab12")).toBe(false);
  });

  it("clears a path entirely", () => {
    serveLine("/p/f.ts", "Ab12", "x");
    markStale("/p/f.ts", "Cd34");
    clearServedPath("/p/f.ts");
    expect(servedText("/p/f.ts", "Ab12")).toBeUndefined();
    expect(isStale("/p/f.ts", "Cd34")).toBe(false);
  });

  it("prunes only non-matching entries after a write", () => {
    serveLine("/p/f.ts", "Ab12", "same");
    serveLine("/p/f.ts", "Cd34", "old");
    pruneServedPath("/p/f.ts", new Map([["Ab12", "same"], ["Ef56", "new"]]));
    expect(servedText("/p/f.ts", "Ab12")).toBe("same");
    expect(servedText("/p/f.ts", "Cd34")).toBeUndefined();
  });

  it("reconcileServed transfers authorization and marks changed lines stale", () => {
    serveLine("/p/f.ts", "A000", "start");
    serveLine("/p/f.ts", "A001", "middle");
    serveLine("/p/f.ts", "A002", "end");
    // External change: middle became MIDDLE (new anchor B111); start/end kept.
    reconcileServed(
      "/p/f.ts",
      ["A000", "A001", "A002"],
      new Map([
        [0, 0],
        [2, 2],
      ]),
      ["A000", "B111", "A002"],
      ["start", "MIDDLE", "end"],
    );
    expect(servedText("/p/f.ts", "A000")).toBe("start");
    expect(servedText("/p/f.ts", "A002")).toBe("end");
    expect(isStale("/p/f.ts", "B111")).toBe(true);
    expect(isStale("/p/f.ts", "A000")).toBe(false);
  });

  it("does not mark lines stale when nothing was served before", () => {
    reconcileServed(
      "/p/f.ts",
      ["A000", "A001"],
      new Map([[0, 0]]),
      ["A000", "B111"],
      ["start", "MIDDLE"],
    );
    expect(isStale("/p/f.ts", "B111")).toBe(false);
  });

  it("transfers authorization when a line keeps its text under a new anchor", () => {
    serveLine("/p/f.ts", "A000", "same");
    reconcileServed(
      "/p/f.ts",
      ["A000"],
      new Map([[0, 0]]),
      ["B222"],
      ["same"],
    );
    expect(servedText("/p/f.ts", "B222")).toBe("same");
  });
});
