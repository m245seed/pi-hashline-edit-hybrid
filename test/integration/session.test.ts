import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withStateDir } from "../support/env";
import { initHasher } from "../../src/anchors/hasher";
import {
  loadStore,
  requireStore,
  resetStoreForTests,
} from "../../src/state/database";
import { resetServed, serveLine, servedText } from "../../src/served/ledger";
import {
  getContextEpoch,
  resetContextEpoch,
} from "../../src/served/epoch";
import {
  addFreeze,
  clearFreezesForTests,
  isFrozen,
} from "../../src/integration/freeze";
import { registerSession } from "../../src/integration/session";

interface FakePi {
  on: (event: string, handler: (...args: never[]) => unknown) => void;
  registerCommand: (name: string, options: unknown) => void;
  handlers: Map<string, (...args: never[]) => unknown>;
  commands: Map<string, unknown>;
}

function makeFakePi(): FakePi {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const commands = new Map<string, unknown>();
  return {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    handlers,
    commands,
  };
}

function makeCtx(): { ui: { notify: (msg: string) => void }; cwd: string } {
  return { ui: { notify: () => {} }, cwd: "/tmp" };
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
  clearFreezesForTests();
  await resetStoreForTests();
  resetContextEpoch();
});

describe("session lifecycle (spec §8.1, PH-CONTEXT-003)", () => {
  it("session_start resets served authorization and restores persisted freezes", async () => {
    await loadStore();
    addFreeze({
      freezeId: "frz_boot",
      reasonCode: "SENTINEL_DEGRADED",
      receivedAt: new Date().toISOString(),
    });
    // Simulate a reload: in-memory freeze and served state are gone.
    clearFreezesForTests();
    serveLine("/gone/f.ts", "Ab12", "stale authorization");
    expect(isFrozen()).toBe(false);

    const pi = makeFakePi();
    registerSession(pi as never, { value: true });
    await (pi.handlers.get("session_start") as (e: never, c: never) => Promise<void>)(
      {} as never,
      makeCtx() as never,
    );

    // Freeze restored (spec §12.5): a reload must not restore mutations.
    expect(isFrozen()).toBe(true);
    // Served authorization is session-scoped: the ledger was reset.
    expect(servedText("/gone/f.ts", "Ab12")).toBeUndefined();
  });

  it("session_compact advances the context epoch", () => {
    const pi = makeFakePi();
    registerSession(pi as never, { value: true });
    const before = getContextEpoch();
    (pi.handlers.get("session_compact") as () => void)();
    expect(getContextEpoch()).toBe(before + 1);
  });

  it("session_shutdown closes the persistent store", async () => {
    await loadStore();
    expect(() => requireStore()).not.toThrow();
    const pi = makeFakePi();
    registerSession(pi as never, { value: true });
    (pi.handlers.get("session_shutdown") as () => void)();
    expect(() => requireStore()).toThrow(/E_STATE_CORRUPT/);
  });

  it("toggle-auto-read flips the shared auto-read state", async () => {
    const autoReadState = { value: true };
    const pi = makeFakePi();
    registerSession(pi as never, autoReadState);
    const command = pi.commands.get("toggle-auto-read") as {
      handler: (args: never[], ctx: never) => Promise<void>;
    };
    let notified = "";
    await command.handler([], { ui: { notify: (msg: string) => (notified = msg) } } as never);
    expect(autoReadState.value).toBe(false);
    expect(notified).toContain("disabled");
    await command.handler([], { ui: { notify: () => {} } } as never);
    expect(autoReadState.value).toBe(true);
  });
});
