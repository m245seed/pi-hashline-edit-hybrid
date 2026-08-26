import { beforeAll, describe, expect, it } from "vitest";
import { AnchorAllocator } from "../../src/anchors/allocator";
import { initHasher, xxh64, fallbackHasher } from "../../src/anchors/hasher";
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

  it("xxh64 matches canonical xxHash64 reference vectors", () => {
    // Pins the WASM implementation: a silent fallback substitution would
    // change these vectors and fail here.
    expect(xxh64("")).toBe(0xef46db3751d8e999n);
    expect(xxh64("a")).toBe(0xd24ec4f1a98c6e5bn);
    expect(xxh64("abc")).toBe(0x44bc2cf5ad770999n);
    expect(xxh64("hello")).toBe(0x26c7827d889f6da3n);
    expect(xxh64("hello")).not.toBe(xxh64("hellp"));
  });

  it("fallback hasher matches canonical FNV-1a vectors (pre-init path)", () => {
    expect(fallbackHasher.h64("")).toBe(0xcbf29ce484222325n);
    expect(fallbackHasher.h64("a")).toBe(0xaf63dc4c8601ec8cn);
    expect(fallbackHasher.h64("foobar")).toBe(0x85944171f73967e8n);
    expect(fallbackHasher.h32("")).toBe(0x811c9dc5);
    expect(fallbackHasher.h32("a")).toBe(0xe40c292c);
    expect(fallbackHasher.h32("foobar")).toBe(0xbf9cf968);
    // Seeds perturb both widths; hex rendering is consistent with h64.
    expect(fallbackHasher.h64("a", 1n)).not.toBe(fallbackHasher.h64("a"));
    expect(fallbackHasher.h32("a", 1)).not.toBe(fallbackHasher.h32("a"));
    expect(fallbackHasher.h64ToString("a")).toBe(fallbackHasher.h64("a").toString(16));
  });
});
