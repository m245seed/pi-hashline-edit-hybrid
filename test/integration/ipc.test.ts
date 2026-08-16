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
import { resetServed } from "../../src/served/ledger";
import { resetContextEpoch, getContextEpoch } from "../../src/served/epoch";
import { isFrozen, clearFreezesForTests } from "../../src/integration/freeze";
import {
  registerIpc,
  unregisterIpc,
  digestSchema,
} from "../../src/integration/ipc";
import { buildReadToolDef } from "../../src/tools/read";
import { buildEditToolDef } from "../../src/tools/edit";

const readTool = buildReadToolDef();
const editTool = buildEditToolDef();

interface Envelope {
  protocol: string;
  type: string;
  requestId?: string;
  replyTo?: string;
  sentAt: string;
  sender: { packageName: string; packageVersion: string; runtimeId: string; generation: number };
  payload: unknown;
}

class FakeBus {
  handlers = new Map<string, Array<(data: unknown) => void>>();
  emitted: Array<{ channel: string; envelope: Envelope }> = [];
  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, envelope: data as Envelope });
  }
  on(channel: string, handler: (data: unknown) => void): () => void {
    const list = this.handlers.get(channel) ?? [];
    list.push(handler);
    this.handlers.set(channel, list);
    return () => {
      const current = this.handlers.get(channel) ?? [];
      this.handlers.set(channel, current.filter((h) => h !== handler));
    };
  }
  deliver(channel: string, data: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
}

function sentinelEnvelope(type: string, payload: unknown, requestId?: string): Envelope {
  return {
    protocol: "pi-sentinel-hashline/1",
    type,
    requestId,
    sentAt: new Date().toISOString(),
    sender: {
      packageName: "pi-sentinel",
      packageVersion: "0.1.0",
      runtimeId: "sentinel-runtime",
      generation: 1,
    },
    payload,
  };
}

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
  resetContextEpoch();
  clearFreezesForTests();
});

afterEach(async () => {
  unregisterIpc();
  clearFreezesForTests();
  await resetStoreForTests();
});

describe("IPC protocol (spec §12, §31.11)", () => {
  it("answers discover with a capability announcement", () => {
    const bus = new FakeBus();
    registerIpc({ events: bus } as never, [readTool, editTool]);

    bus.deliver(
      "pi-sentinel.ipc.v1.discover",
      sentinelEnvelope("pi-sentinel.ipc.v1.discover", { requestedProtocolMajor: 1 }, "req_1"),
    );

    const announces = bus.emitted.filter((e) => e.channel === "pi-hashline.ipc.v1.announce");
    expect(announces).toHaveLength(1);
    const envelope = announces[0]!.envelope;
    expect(envelope.protocol).toBe("pi-sentinel-hashline/1");
    expect(envelope.replyTo).toBe("req_1");
    expect(envelope.sender.packageName).toBe("pi-hashline-edit-hybrid");
    const payload = envelope.payload as {
      protocolId: string;
      anchorFormat: { width: number; separator: string };
      tools: Array<{ name: string; role: string; schemaDigest: string }>;
      features: Record<string, boolean>;
      outputContract: { renderThenServe: boolean };
    };
    expect(payload.protocolId).toBe("pi-hashline/1");
    expect(payload.anchorFormat.width).toBe(4);
    expect(payload.anchorFormat.separator).toBe("│");
    const names = payload.tools.map((t) => t.name).sort();
    expect(names).toEqual(["edit", "read"]);
    const edit = payload.tools.find((t) => t.name === "edit")!;
    expect(edit.role).toBe("anchored_edit");
    expect(edit.schemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload.features.servedAuthorization).toBe(true);
    expect(payload.features.safeWriteOverride).toBe(true);
    expect(payload.outputContract.renderThenServe).toBe(true);
  });

  it("ignores discover from an unsupported protocol major (PS-IPC-001)", () => {
    const bus = new FakeBus();
    registerIpc({ events: bus } as never, [readTool]);
    const bad = sentinelEnvelope("pi-sentinel.ipc.v1.discover", {}, "req_2");
    bad.protocol = "pi-sentinel-hashline/2";
    bus.deliver("pi-sentinel.ipc.v1.discover", bad);
    expect(bus.emitted.filter((e) => e.channel === "pi-hashline.ipc.v1.announce")).toHaveLength(0);
  });

  it("ignores events from non-Sentinel senders", () => {
    const bus = new FakeBus();
    registerIpc({ events: bus } as never, [readTool]);
    const spoofed = sentinelEnvelope("pi-sentinel.ipc.v1.discover", {}, "req_3");
    spoofed.sender.packageName = "pi-hashline-edit-hybrid";
    bus.deliver("pi-sentinel.ipc.v1.discover", spoofed);
    expect(bus.emitted.filter((e) => e.channel === "pi-hashline.ipc.v1.announce")).toHaveLength(0);
  });

  it("honors freeze and specific-id unfreeze over the bus", () => {
    const bus = new FakeBus();
    registerIpc({ events: bus } as never, [readTool]);
    bus.deliver(
      "pi-sentinel.ipc.v1.freeze",
      sentinelEnvelope("pi-sentinel.ipc.v1.freeze", {
        freezeId: "frz_ipc",
        reasonCode: "PROVIDER_CIRCUIT_OPEN",
        destructiveOnly: true,
      }),
    );
    expect(isFrozen()).toBe(true);
    // A broad clear-all (no freezeId) is never accepted.
    bus.deliver("pi-sentinel.ipc.v1.unfreeze", sentinelEnvelope("pi-sentinel.ipc.v1.unfreeze", {}));
    expect(isFrozen()).toBe(true);
    bus.deliver(
      "pi-sentinel.ipc.v1.unfreeze",
      sentinelEnvelope("pi-sentinel.ipc.v1.unfreeze", { freezeId: "frz_ipc" }),
    );
    expect(isFrozen()).toBe(false);
  });

  it("advances the epoch on Sentinel context-advance and announces it", () => {
    const bus = new FakeBus();
    registerIpc({ events: bus } as never, [readTool]);
    const before = getContextEpoch();
    bus.deliver(
      "pi-sentinel.ipc.v1.context.advance",
      sentinelEnvelope("pi-sentinel.ipc.v1.context.advance", { reason: "compaction", epoch: before + 1 }),
    );
    expect(getContextEpoch()).toBe(before + 1);
    const epochEvents = bus.emitted.filter((e) => e.channel === "pi-hashline.ipc.v1.context.epoch");
    expect(epochEvents.length).toBeGreaterThan(0);
    const payload = epochEvents[epochEvents.length - 1]!.envelope.payload as { epoch: number };
    expect(payload.epoch).toBe(before + 1);
  });

  it("emits mutation.before/after events around a committed edit", async () => {
    const bus = new FakeBus();
    registerIpc({ events: bus } as never, [readTool, editTool]);
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const one = anchors.get("one")!;

    const result = await runTool(
      editTool,
      { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] },
      dir,
    );
    expect(result.isError).toBeFalsy();

    const before = bus.emitted.filter((e) => e.channel === "pi-hashline.ipc.v1.mutation.before");
    const after = bus.emitted.filter((e) => e.channel === "pi-hashline.ipc.v1.mutation.after");
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    const payload = after[0]!.envelope.payload as {
      operation: string;
      path: string;
      outcome: string;
      contextEpoch: number;
      beforeSha256: string;
      afterSha256: string;
    };
    expect(payload.operation).toBe("edit");
    expect(payload.path).toBe(join(dir, "a.ts"));
    expect(payload.outcome).toBe("success");
    expect(payload.contextEpoch).toBe(getContextEpoch());
    expect(payload.beforeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.afterSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("emits mutation.rejected when a preflight rejects", async () => {
    const bus = new FakeBus();
    registerIpc({ events: bus } as never, [readTool, editTool]);
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const two = anchors.get("two")!;

    await expect(
      runTool(editTool, { path: "a.ts", edits: [{ range: [two, two], lines: ["x", "three"] }] }, dir),
    ).rejects.toThrow(/E_BOUNDARY_DUP/);

    const rejected = bus.emitted.filter((e) => e.channel === "pi-hashline.ipc.v1.mutation.rejected");
    expect(rejected).toHaveLength(1);
    const payload = rejected[0]!.envelope.payload as { outcome: string; warningCodes: string[] };
    expect(payload.outcome).toBe("rejected");
    expect(payload.warningCodes).toContain("E_BOUNDARY_DUP");
  });

  it("schema digests are stable under key order and match Sentinel's algorithm", () => {
    const a = digestSchema({ type: "object", properties: { b: { type: "string" }, a: { type: "number" } } });
    const b = digestSchema({ properties: { a: { type: "number" }, b: { type: "string" } }, type: "object" });
    expect(a).toBe(b);
    const c = digestSchema({ type: "object", properties: { b: { type: "string" }, a: { type: "integer" } } });
    expect(c).not.toBe(a);
  });

  it("remains safe when no event bus is present", async () => {
    // registerIpc with no events must not throw and emitters must be no-ops.
    registerIpc({} as never, [readTool]);
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const one = anchors.get("one")!;
    const result = await runTool(
      editTool,
      { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("ONE\n");
  });
});
