import { beforeAll, describe, expect, it } from "vitest";
import { AnchorAllocator } from "../../src/anchors/allocator";
import { initHasher } from "../../src/anchors/hasher";
import { ANCHOR_RE } from "../../src/anchors/alphabet";

beforeAll(async () => {
  await initHasher();
});

describe("anchor allocation (spec §51)", () => {
  it("allocates unique anchors", () => {
    const allocator = new AnchorAllocator(new Set(), new Set());
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const anchor = allocator.allocate(`line ${i}`);
      expect(ANCHOR_RE.test(anchor)).toBe(true);
      expect(seen.has(anchor)).toBe(false);
      seen.add(anchor);
    }
  });

  it("never allocates an active anchor", () => {
    const allocator = new AnchorAllocator(new Set(["Ab12", "Cd34"]), new Set());
    const seen = new Set(["Ab12", "Cd34"]);
    for (let i = 0; i < 500; i++) {
      const anchor = allocator.allocate(`line ${i}`);
      expect(seen.has(anchor)).toBe(false);
      seen.add(anchor);
    }
  });

  it("never allocates a retired anchor", () => {
    const allocator = new AnchorAllocator(new Set(), new Set(["Ab12", "Cd34"]));
    const seen = new Set(["Ab12", "Cd34"]);
    for (let i = 0; i < 500; i++) {
      const anchor = allocator.allocate(`line ${i}`);
      expect(seen.has(anchor)).toBe(false);
      seen.add(anchor);
    }
  });

  it("is deterministic for identical line content", () => {
    const a = new AnchorAllocator(new Set(), new Set());
    const b = new AnchorAllocator(new Set(), new Set());
    const lines = ["}", "}", "}", "", "", "  x", "  x"];
    const ra = lines.map((l) => a.allocate(l));
    const rb = lines.map((l) => b.allocate(l));
    expect(ra).toEqual(rb);
  });

  it("handles repeated identical lines without collision", () => {
    const allocator = new AnchorAllocator(new Set(), new Set());
    const anchors = new Array<string>(1000).fill("}").map((l) => allocator.allocate(l));
    expect(new Set(anchors).size).toBe(1000);
  });
});
