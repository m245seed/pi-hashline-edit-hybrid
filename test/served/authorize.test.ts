import { beforeEach, describe, expect, it } from "vitest";
import { resetServed, servedText, serveLines } from "../../src/served/ledger";
import { checkRangeServed, formatRangeFailure, feedbackRange } from "../../src/served/authorize";

const PATH = "/tmp/file.ts";

beforeEach(() => {
  resetServed();
});

describe("served-state authorization (spec §10, §60)", () => {
  const anchors = ["A000", "A001", "A002", "A003", "A004"];
  const texts = ["start", "middle", "end", "four", "five"];

  it("serves lines through serveLines", () => {
    serveLines(PATH, [{ anchor: "A000", exactText: "start" }]);
    expect(servedText(PATH, "A000")).toBe("start");
    expect(servedText(PATH, "A001")).toBeUndefined();
  });

  it("fully served range succeeds", () => {
    serveLines(PATH, [
      { anchor: "A001", exactText: "middle" },
      { anchor: "A002", exactText: "end" },
    ]);
    const check = checkRangeServed(PATH, anchors, texts, 1, 2);
    expect(check.ok).toBe(true);
  });

  it("unseen endpoint fails with E_RANGE_UNSERVED", () => {
    serveLines(PATH, [{ anchor: "A001", exactText: "middle" }]);
    const check = checkRangeServed(PATH, anchors, texts, 0, 1);
    expect(check.ok).toBe(false);
    expect(check.code).toBe("E_RANGE_UNSERVED");
    expect(check.unserved).toContain(0);
  });

  it("unseen interior fails", () => {
    serveLines(PATH, [
      { anchor: "A000", exactText: "start" },
      { anchor: "A004", exactText: "five" },
    ]);
    const check = checkRangeServed(PATH, anchors, texts, 0, 4);
    expect(check.ok).toBe(false);
    expect(check.code).toBe("E_RANGE_UNSERVED");
    expect(check.unserved).toContain(1);
    expect(check.unserved).toContain(2);
    expect(check.unserved).toContain(3);
  });

  it("changed endpoint fails with E_RANGE_STALE", () => {
    serveLines(PATH, [
      { anchor: "A000", exactText: "start" },
      { anchor: "A001", exactText: "middle" },
    ]);
    // Line 1 changed on disk.
    const changedTexts = ["start", "MIDDLE", "end", "four", "five"];
    const check = checkRangeServed(PATH, anchors, changedTexts, 0, 1);
    expect(check.ok).toBe(false);
    expect(check.code).toBe("E_RANGE_STALE");
    expect(check.stale).toEqual([1]);
  });

  it("changed interior fails", () => {
    serveLines(PATH, [
      { anchor: "A000", exactText: "start" },
      { anchor: "A001", exactText: "middle" },
      { anchor: "A002", exactText: "end" },
    ]);
    const changedTexts = ["start", "middle", "END!", "four", "five"];
    const check = checkRangeServed(PATH, anchors, changedTexts, 0, 2);
    expect(check.ok).toBe(false);
    expect(check.code).toBe("E_RANGE_STALE");
    expect(check.stale).toEqual([2]);
  });

  it("unchanged external edit elsewhere still allows the range", () => {
    serveLines(PATH, [
      { anchor: "A000", exactText: "start" },
      { anchor: "A001", exactText: "middle" },
    ]);
    // Line 4 changed externally; range 0-1 is unaffected.
    const changedTexts = ["start", "middle", "end", "four", "FIVE!"];
    const check = checkRangeServed(PATH, anchors, changedTexts, 0, 1);
    expect(check.ok).toBe(true);
  });

  it("error feedback becomes served (spec §9)", () => {
    const message = formatRangeFailure("file.ts", PATH, anchors, texts, 0, 1, {
      ok: false,
      code: "E_RANGE_UNSERVED",
      unserved: [0],
      stale: [],
    });
    expect(message).toContain("[E_RANGE_UNSERVED]");
    expect(message).toContain("Nothing was modified.");
    // The returned fresh rows are served.
    expect(servedText(PATH, "A000")).toBe("start");
    expect(servedText(PATH, "A001")).toBe("middle");
  });

  it("E_RANGE_STALE feedback is bounded and served", () => {
    const bigAnchors = Array.from({ length: 500 }, (_, i) => `B${String(i).padStart(3, "0")}`);
    const bigTexts = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const message = formatRangeFailure("file.ts", PATH, bigAnchors, bigTexts, 0, 499, {
      ok: false,
      code: "E_RANGE_STALE",
      unserved: [],
      stale: [499],
    });
    expect(message).toContain("[E_RANGE_STALE]");
    expect(servedText(PATH, "B000")).toBe("line 0");
  });

  it("feedbackRange serves only fully shown rows", () => {
    feedbackRange(PATH, anchors, texts, 0, 4);
    expect(servedText(PATH, "A004")).toBe("five");
  });

  it("clears on reset (session scope)", () => {
    serveLines(PATH, [{ anchor: "A000", exactText: "start" }]);
    resetServed();
    expect(servedText(PATH, "A000")).toBeUndefined();
  });
});
