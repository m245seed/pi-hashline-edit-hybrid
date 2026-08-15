import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withStateDir } from "../support/env";
import { makeProject, runTool, textOf, writeFileAt, readFileAt } from "../support/tools";
import { initHasher } from "../../src/anchors/hasher";
import { resetStoreForTests } from "../../src/state/database";
import { resetServed } from "../../src/served/ledger";
import { buildReadToolDef } from "../../src/tools/read";
import { buildEditToolDef } from "../../src/tools/edit";
import { buildInsertToolDef } from "../../src/tools/insert";
import {
  commitMutation,
  loadAnchoredFile,
  newTransactionIdFor,
  anchorSpaceWarning,
  mixedEndingsWarning,
  encodeAfterBytes,
} from "../../src/mutation/transaction";
import { decodeDocument } from "../../src/document/decode";
import { applyTransaction } from "../../src/mutation/apply";
import { fingerprintHexes } from "../../src/anchors/fingerprints";
import { sha256Hex } from "../../src/utils";
import { join } from "path";

const readTool = buildReadToolDef();
const editTool = buildEditToolDef();
const insertTool = buildInsertToolDef();

function anchorsFromRead(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z0-9]{4})│(.*)$/);
    if (match) map.set(match[2]!, match[1]!);
  }
  return map;
}

beforeAll(async () => {
  await initHasher();
});

beforeEach(() => {
  withStateDir();
  resetServed();
});

afterEach(async () => {
  await resetStoreForTests();
});

describe("transaction edge cases (spec §47, §52)", () => {
  it("aborts before commit when cancelled (E_ABORTED)", async () => {
    const dir = makeProject();
    const path = writeFileAt(dir, "a.ts", "one\ntwo\n");
    const file = await loadAnchoredFile(path, "a.ts");
    const abortController = new AbortController();
    abortController.abort();
    const result = applyTransaction(
      file.doc,
      { anchors: file.anchors, retired: file.retired },
      [{ kind: "edit", start: 0, end: 0, lines: ["ONE"], requestIndex: 0 }],
    );
    const afterRaw = encodeAfterBytes(result.document);
    await expect(
      commitMutation({
        realPath: path,
        label: "a.ts",
        rawBefore: file.raw,
        checksumBefore: file.checksum,
        docBefore: file.doc,
        anchorsBefore: file.anchors,
        fingerprintsBefore: file.fingerprints,
        retiredBefore: file.retired,
        rawAfter: afterRaw,
        checksumAfter: sha256Hex(afterRaw),
        docAfter: result.document,
        anchorsAfter: result.anchors,
        fingerprintsAfter: fingerprintHexes(result.document.lines.map((l) => l.text)),
        retiredAfter: new Set([...file.retired, ...result.retiredAdded]),
        transactionId: newTransactionIdFor(),
        signal: abortController.signal,
        keepUndo: true,
        warnings: [],
      }),
    ).rejects.toThrow(/E_ABORTED/);
    expect(readFileAt(path)).toBe("one\ntwo\n");
  });

  it("produces the anchor-space pressure warning near exhaustion", () => {
    const warning = anchorSpaceWarning(0, 14_100_000);
    expect(warning).toContain("[W_ANCHOR_SPACE_PRESSURE]");
    expect(anchorSpaceWarning(1, 1)).toBeUndefined();
  });

  it("produces the mixed-endings warning when lines are added", () => {
    const mixed = decodeDocument(Buffer.from("a\nb\r\n", "utf-8"), "t");
    expect(mixedEndingsWarning(mixed, 1)).toContain("[W_MIXED_LINE_ENDINGS]");
    expect(mixedEndingsWarning(mixed, 0)).toBeUndefined();
    const uniform = decodeDocument(Buffer.from("a\nb\n", "utf-8"), "t");
    expect(mixedEndingsWarning(uniform, 1)).toBeUndefined();
  });

  it("issues the unused-final_newline warning through the insert tool", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchor = anchorsFromRead(textOf(read)).get("one")!;
    const result = await runTool(
      insertTool,
      { path: "a.ts", inserts: [{ anchor, direction: "after", lines: ["x"] }], final_newline: "absent" },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("[W_UNUSED_OPTION]");
  });

  it("reports a noop for an empty insert", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchor = anchorsFromRead(textOf(read)).get("one")!;
    const result = await runTool(
      insertTool,
      { path: "a.ts", inserts: [{ anchor, direction: "after", lines: [] }] },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No changes made.");
  });

  it("validates insert flags strictly", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\n");
    await expect(
      runTool(
        insertTool,
        { path: "a.ts", inserts: [{ anchor: "Ab12", direction: "after", lines: ["x"] }], allow_display_like_content: "yes" },
        dir,
      ),
    ).rejects.toThrow(/E_BAD_SHAPE/);
    await expect(
      runTool(
        insertTool,
        { path: "a.ts", inserts: [{ anchor: "Ab12", direction: "after", lines: ["x"] }], expected_revision: "zzz" },
        dir,
      ),
    ).rejects.toThrow(/E_BAD_SHAPE/);
  });

  it("validates read offset/limit strictly", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\n");
    await expect(runTool(readTool, { path: "a.ts", offset: 0 }, dir)).rejects.toThrow(/E_BAD_SHAPE/);
    await expect(runTool(readTool, { path: "a.ts", limit: 1.5 }, dir)).rejects.toThrow(/E_BAD_SHAPE/);
    await expect(runTool(readTool, { path: "" }, dir)).rejects.toThrow(/E_BAD_SHAPE/);
  });

  it("rejects edit payloads with unpaired surrogates via the tool", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchor = anchorsFromRead(textOf(read)).get("one")!;
    await expect(
      runTool(
        editTool,
        { path: "a.ts", edits: [{ range: [anchor, anchor], lines: ["a\uD800b"] }] },
        dir,
      ),
    ).rejects.toThrow(/E_BAD_SHAPE/);
  });
});
