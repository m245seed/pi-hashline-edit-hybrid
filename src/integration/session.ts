/**
 * Session lifecycle (spec §8.1, §31, §49, PH-CONTEXT-001..005).
 *
 * At session start: initialize the hasher, open the state store, run crash
 * recovery on pending transactions, reset the served ledger, and restore any
 * persisted Sentinel freezes — anchors and undo survive restarts, but
 * permission to destructively edit previously viewed lines does not. The
 * generic `edit`/`write` tools are replaced by the hybrid tools at
 * registration time (custom tools override built-ins by name).
 *
 * Context epochs (PH-CONTEXT-003): the served-authorization epoch advances
 * when the model's context is rebuilt — compaction, tree navigation, or a
 * session transition — so anchors from the previous context no longer
 * authorize destructive edits. Undo history and file identity are
 * independent of the epoch (PH-CONTEXT-005).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initHasher } from "../anchors/hasher";
import { loadStore, shutdownStore } from "../state/database";
import { runRecovery } from "../state/recovery";
import { resetServed } from "../served/ledger";
import { advanceContextEpoch } from "../served/epoch";
import { restoreFreezes } from "./freeze";
import { emitContextEpoch } from "./ipc";

export function registerSession(pi: ExtensionAPI, autoReadState: { value: boolean }): void {
  pi.on("session_start", async (_event, ctx) => {
    // xxhash-wasm initialization falls back to the pure-JS hasher
    // internally (see hasher.ts) and never rejects; the store and
    // served-state reset below must run regardless of its outcome.
    await initHasher();
    try {
      await loadStore();
      const summary = await runRecovery();
      for (const warning of summary.warnings) {
        console.warn(warning);
      }
      if (summary.promoted > 0 || summary.discarded > 0 || summary.diverged > 0) {
        ctx.ui.notify(
          `Hashline state recovery: ${summary.promoted} transaction(s) finalized, ${summary.discarded} discarded, ${summary.diverged} diverged.`,
          "info",
        );
      }
    } catch (error) {
      console.error("Failed to open hashline state store:", error);
    }
    // Session-scoped served authorization (spec §8.1).
    resetServed();
    // Restore persisted Sentinel freezes so a reload does not silently
    // restore mutation capability (spec §12.5).
    await restoreFreezes();
  });

  // PH-CONTEXT-003: compaction rebuilds the model's context, so served
  // authorizations from before it must stop authorizing destructive edits.
  // Tree navigation and session transitions are announced by Sentinel over
  // the context-advance IPC event (handled in ipc.ts).
  pi.on("session_compact", () => {
    advanceContextEpoch("session_compact");
    emitContextEpoch("session_compact");
  });

  pi.on("session_shutdown", () => {
    shutdownStore();
  });

  pi.registerCommand("toggle-auto-read", {
    description:
      "Toggle automatic anchored preview after write (default: enabled)",
    handler: async (_args, ctx) => {
      autoReadState.value = !autoReadState.value;
      ctx.ui.notify(
        `Auto-read anchors after write: ${autoReadState.value ? "enabled" : "disabled"}`,
        "info",
      );
    },
  });
}
