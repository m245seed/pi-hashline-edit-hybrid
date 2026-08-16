import { describe, expect, it } from "vitest";
import {
  validateEditRequest,
  validateInsertRequest,
  DISPLAY_LIKE_RE,
} from "../../src/mutation/validate";

describe("strict payload validation (spec §15, §17)", () => {
  it("rejects missing path", () => {
    expect(() => validateEditRequest({ edits: [{ range: ["Ab12", "Cd34"], lines: ["x"] }] })).toThrow(/E_BAD_SHAPE/);
  });

  it("rejects empty edits", () => {
    expect(() => validateEditRequest({ path: "f", edits: [] })).toThrow(/E_BAD_SHAPE/);
  });

  it("rejects missing edits", () => {
    expect(() => validateEditRequest({ path: "f" })).toThrow(/E_BAD_SHAPE/);
  });

  it("rejects unknown fields", () => {
    expect(() => validateEditRequest({ path: "f", edits: [{ range: ["Ab12", "Cd34"], lines: ["x"] }], bogus: 1 })).toThrow(/E_BAD_SHAPE.*bogus/);
    expect(() => validateEditRequest({ path: "f", edits: [{ range: ["Ab12", "Cd34"], lines: ["x"], extra: true }] })).toThrow(/E_BAD_SHAPE.*extra/);
  });

  it("rejects malformed anchors", () => {
    for (const bad of ["Ab1", "Ab12c", "ab-c", "Ab12│", "Ab12│content", "+Ab12", "-Ab12", " Ab12", ""]) {
      expect(
        () => validateEditRequest({ path: "f", edits: [{ range: [bad, "Cd34"], lines: ["x"] }] }),
        JSON.stringify(bad),
      ).toThrow(/E_BAD_REF/);
    }
  });

  it("rejects malformed ranges", () => {
    expect(() => validateEditRequest({ path: "f", edits: [{ range: ["Ab12"], lines: ["x"] }] })).toThrow(/E_BAD_SHAPE/);
    expect(() => validateEditRequest({ path: "f", edits: [{ range: ["Ab12", "Cd34", "Ef56"], lines: ["x"] }] })).toThrow(/E_BAD_SHAPE/);
    expect(() => validateEditRequest({ path: "f", edits: [{ range: ["Ab12", "Cd34"] }] })).toThrow(/E_BAD_SHAPE/);
  });

  it("rejects line values containing newlines", () => {
    expect(() =>
      validateEditRequest({ path: "f", edits: [{ range: ["Ab12", "Cd34"], lines: ["a\nb"] }] }),
    ).toThrow(/E_EMBEDDED_NEWLINE/);
    expect(() =>
      validateEditRequest({ path: "f", edits: [{ range: ["Ab12", "Cd34"], lines: ["a\rb"] }] }),
    ).toThrow(/E_EMBEDDED_NEWLINE/);
  });

  it("rejects unsupported control bytes", () => {
    expect(() =>
      validateEditRequest({ path: "f", edits: [{ range: ["Ab12", "Cd34"], lines: ["a\u0000b"] }] }),
    ).toThrow(/E_BAD_SHAPE/);
    // Tab is allowed.
    expect(
      validateEditRequest({ path: "f", edits: [{ range: ["Ab12", "Cd34"], lines: ["\tindented"] }] }),
    ).toMatchObject({ edits: [{ lines: ["\tindented"] }] });
  });

  it("rejects unpaired surrogates", () => {
    expect(() =>
      validateEditRequest({ path: "f", edits: [{ range: ["Ab12", "Cd34"], lines: ["a\uD800b"] }] }),
    ).toThrow(/E_BAD_SHAPE/);
    // A real surrogate pair is fine.
    expect(
      validateEditRequest({ path: "f", edits: [{ range: ["Ab12", "Cd34"], lines: ["\uD83D\uDE00"] }] }),
    ).toMatchObject({ edits: [{ lines: ["\uD83D\uDE00"] }] });
  });

  it("rejects final_newline values outside the enum", () => {
    expect(() =>
      validateEditRequest({ path: "f", edits: [{ range: ["Ab12", "Cd34"], lines: ["x"] }], final_newline: "sometimes" }),
    ).toThrow(/E_BAD_SHAPE/);
  });

  it("rejects malformed expected_revision", () => {
    expect(() =>
      validateEditRequest({ path: "f", edits: [{ range: ["Ab12", "Cd34"], lines: ["x"] }], expected_revision: "abc" }),
    ).toThrow(/E_BAD_SHAPE/);
  });
});

describe("suspicious hashline content (spec §17)", () => {
  const cases = [
    "Ab31│console.log(\"hello\")",
    "+Ab31│console.log(\"hello\")",
    "-Ab31│console.log(\"hello\")",
    " Ab31│console.log(\"hello\")",
  ];

  for (const content of cases) {
    it(`rejects ${JSON.stringify(content.slice(0, 8))} without override`, () => {
      expect(() =>
        validateEditRequest({ path: "f", edits: [{ range: ["Ab12", "Cd34"], lines: [content] }] }),
      ).toThrow(/E_DISPLAY_LIKE_CONTENT/);
      expect(() =>
        validateInsertRequest({ path: "f", inserts: [{ anchor: "Ab12", direction: "after", lines: [content] }] }),
      ).toThrow(/E_DISPLAY_LIKE_CONTENT/);
    });
  }

  it("writes suspicious content literally with allow_display_like_content", () => {
    const request = validateEditRequest({
      path: "f",
      edits: [{ range: ["Ab12", "Cd34"], lines: ["Ab31│console.log(\"hello\")", "+Ab31│x"] }],
      allow_display_like_content: true,
    });
    expect(request.edits[0]!.lines).toEqual(["Ab31│console.log(\"hello\")", "+Ab31│x"]);
  });

  it("does not reject ordinary content that merely contains a pipe", () => {
    const request = validateEditRequest({
      path: "f",
      edits: [{ range: ["Ab12", "Cd34"], lines: ["const x = a | b;", "  Ab12│ not a row"] }],
    });
    expect(request.edits[0]!.lines.length).toBe(2);
  });

  it("DISPLAY_LIKE_RE matches only full row prefixes", () => {
    expect(DISPLAY_LIKE_RE.test("Ab31│x")).toBe(true);
    expect(DISPLAY_LIKE_RE.test("+Ab31│x")).toBe(true);
    expect(DISPLAY_LIKE_RE.test("-Ab31│x")).toBe(true);
    expect(DISPLAY_LIKE_RE.test(" Ab31│x")).toBe(true);
    expect(DISPLAY_LIKE_RE.test("  Ab31│x")).toBe(false);
    expect(DISPLAY_LIKE_RE.test("const Ab31│x")).toBe(false);
    expect(DISPLAY_LIKE_RE.test("Ab1│x")).toBe(false);
    expect(DISPLAY_LIKE_RE.test("Ab31 x")).toBe(false);
  });
});

describe("insert validation", () => {
  it("rejects bad direction", () => {
    expect(() =>
      validateInsertRequest({ path: "f", inserts: [{ anchor: "Ab12", direction: "around", lines: ["x"] }] }),
    ).toThrow(/E_BAD_SHAPE/);
  });

  it("accepts a valid insert request", () => {
    const request = validateInsertRequest({
      path: "f",
      inserts: [
        { anchor: "Ab12", direction: "after", lines: ["a", "b"] },
        { anchor: "Cd34", direction: "before", lines: [] },
      ],
    });
    expect(request.inserts.length).toBe(2);
    expect(request.inserts[0]!.lines).toEqual(["a", "b"]);
  });

  it("rejects empty inserts", () => {
    expect(() => validateInsertRequest({ path: "f", inserts: [] })).toThrow(/E_BAD_SHAPE/);
  });
});
