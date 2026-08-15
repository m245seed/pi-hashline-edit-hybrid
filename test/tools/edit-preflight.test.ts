import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "path";
import { withStateDir } from "../support/env";
import {
  makeProject,
  readFileAt,
  runTool,
  textOf,
  writeFileAt,
} from "../support/tools";
import { initHasher } from "../../src/anchors/hasher";
import { resetStoreForTests } from "../../src/state/database";
import { resetServed, servedText } from "../../src/served/ledger";
import { loadAnchoredFile } from "../../src/mutation/transaction";
import { buildEditToolDef } from "../../src/tools/edit";
import { buildReadToolDef } from "../../src/tools/read";

const editTool = buildEditToolDef();
const readTool = buildReadToolDef();

function anchorsFromRead(text: string): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z0-9]{4})│(.*)$/);
    if (match) anchors.set(match[2]!, match[1]!);
  }
  return anchors;
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

describe("edit safety preflights", () => {
  it("rejects unchanged boundary duplication before committing", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));

    await expect(
      runTool(
        editTool,
        {
          path: "a.ts",
          edits: [
            {
              range: [anchors.get("two")!, anchors.get("two")!],
              lines: ["replacement", "three"],
            },
          ],
        },
        dir,
      ),
    ).rejects.toThrow(/E_BOUNDARY_DUP/);
    expect(readFileAt(join(dir, "a.ts"))).toBe("one\ntwo\nthree\n");
  });

  it("allows an intentional boundary duplicate with explicit confirmation", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));

    const result = await runTool(
      editTool,
      {
        path: "a.ts",
        edits: [
          {
            range: [anchors.get("two")!, anchors.get("two")!],
            lines: ["replacement", "three"],
          },
        ],
        allow_boundary_duplicate: true,
      },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe(
      "one\nreplacement\nthree\nthree\n",
    );
  });

  it("does not flag duplicated content when the adjacent line is changed by another edit", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "before\ntarget\nafter\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));

    const result = await runTool(
      editTool,
      {
        path: "a.ts",
        edits: [
          {
            range: [anchors.get("target")!, anchors.get("target")!],
            lines: ["replacement", "after"],
          },
          {
            range: [anchors.get("after")!, anchors.get("after")!],
            lines: ["changed"],
          },
        ],
      },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe(
      "before\nreplacement\nafter\nchanged\n",
    );
  });

  it("requires confirmation for unusually destructive replacements", async () => {
    const dir = makeProject();
    const lines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`);
    writeFileAt(dir, "a.ts", `${lines.join("\n")}\n`);
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const edit = {
      range: [anchors.get("line-1")!, anchors.get("line-25")!],
      lines: ["replacement"],
    };

    await expect(
      runTool(editTool, { path: "a.ts", edits: [edit] }, dir),
    ).rejects.toThrow(/E_LARGE_DESTRUCTIVE_EDIT/);
    expect(readFileAt(join(dir, "a.ts"))).toBe(`${lines.join("\n")}\n`);

    const confirmed = await runTool(
      editTool,
      { path: "a.ts", edits: [edit], allow_large_change: true },
      dir,
    );
    expect(confirmed.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe(
      `replacement\n${lines.slice(25).join("\n")}\n`,
    );
  });

  it("does not serve an oversized current row omitted from a diff", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const huge = "x".repeat(300 * 1024);

    const result = await runTool(
      editTool,
      {
        path: "a.ts",
        edits: [
          {
            range: [anchors.get("one")!, anchors.get("one")!],
            lines: [huge],
          },
        ],
      },
      dir,
    );
    expect(textOf(result)).toContain("current diff row omitted");
    expect(textOf(result)).not.toContain("xxxxx");

    const realPath = join(dir, "a.ts");
    const file = await loadAnchoredFile(realPath, "a.ts");
    expect(servedText(realPath, file.anchors[0]!)).toBeUndefined();
  });
});
