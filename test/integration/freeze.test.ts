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
import { resetStoreForTests, loadStore } from "../../src/state/database";
import { resetServed } from "../../src/served/ledger";
import { resetContextEpoch } from "../../src/served/epoch";
import {
  addFreeze,
  removeFreeze,
  isFrozen,
  activeFreezeIds,
  clearFreezesForTests,
  restoreFreezes,
} from "../../src/integration/freeze";
import { buildReadToolDef } from "../../src/tools/read";
import { buildEditToolDef } from "../../src/tools/edit";
import { buildWriteToolDef } from "../../src/tools/write";

const readTool = buildReadToolDef();
const editTool = buildEditToolDef();
const writeTool = buildWriteToolDef();

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

beforeEach(async () => {
  withStateDir();
  resetServed();
  resetContextEpoch();
  clearFreezesForTests();
  await loadStore();
});

afterEach(async () => {
  clearFreezesForTests();
  await resetStoreForTests();
});

describe("freeze handling (spec §12.5, §31.11)", () => {
  it("destructive tools reject with E_FROZEN while a freeze is active", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const one = anchors.get("one")!;

    addFreeze({
      freezeId: "frz_1",
      reasonCode: "READ_ONLY_PROFILE",
      receivedAt: new Date().toISOString(),
    });
    expect(isFrozen()).toBe(true);

    await expect(
      runTool(editTool, { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] }, dir),
    ).rejects.toThrow(/E_FROZEN/);
    await expect(
      runTool(writeTool, { path: "a.ts", content: "x\n", replace_existing: true }, dir),
    ).rejects.toThrow(/E_FROZEN/);
    expect(readFileAt(join(dir, "a.ts"))).toBe("one\ntwo\n");

    // Reads remain available during a freeze.
    const stillReadable = await runTool(readTool, { path: "a.ts" }, dir);
    expect(stillReadable.isError).toBeFalsy();
  });

  it("unfreezing a specific id lifts the freeze", async () => {
    addFreeze({ freezeId: "frz_a", reasonCode: "USER_REQUEST", receivedAt: new Date().toISOString() });
    addFreeze({ freezeId: "frz_b", reasonCode: "USER_REQUEST", receivedAt: new Date().toISOString() });
    expect(activeFreezeIds().sort()).toEqual(["frz_a", "frz_b"]);
    expect(removeFreeze("frz_a")).toBe(true);
    expect(isFrozen()).toBe(true);
    expect(removeFreeze("frz_b")).toBe(true);
    expect(isFrozen()).toBe(false);
    expect(removeFreeze("frz_missing")).toBe(false);
  });

  it("expired freezes do not block mutations", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const one = anchors.get("one")!;

    addFreeze({
      freezeId: "frz_expired",
      reasonCode: "USER_REQUEST",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      receivedAt: new Date().toISOString(),
    });
    expect(isFrozen()).toBe(false);
    const result = await runTool(
      editTool,
      { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] },
      dir,
    );
    expect(result.isError).toBeFalsy();
  });

  it("persists freeze state for the session and restores it", async () => {
    addFreeze({ freezeId: "frz_persist", reasonCode: "SENTINEL_DEGRADED", receivedAt: new Date().toISOString() });
    clearFreezesForTests();
    expect(isFrozen()).toBe(false);
    await restoreFreezes();
    expect(isFrozen()).toBe(true);
    expect(activeFreezeIds()).toEqual(["frz_persist"]);
  });

  it("persists freezes even when added before the store is open", async () => {
    await resetStoreForTests();
    addFreeze({
      freezeId: "frz_deferred",
      reasonCode: "USER_REQUEST",
      receivedAt: new Date().toISOString(),
    });
    // The deferred persistence write resolves once the store opens.
    await restoreFreezes();
    clearFreezesForTests();
    expect(isFrozen()).toBe(false);
    await restoreFreezes();
    expect(isFrozen()).toBe(true);
    expect(activeFreezeIds()).toEqual(["frz_deferred"]);
  });
});
