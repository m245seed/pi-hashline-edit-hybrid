/**
 * Session lifecycle (spec §8.1, §31, §49).
 *
 * At session start: initialize the hasher, open the state store, run crash
 * recovery on pending transactions, and reset the served ledger — anchors
 * and undo survive restarts, but permission to destructively edit
 * previously viewed lines does not. The generic `edit` tool is replaced by
 * the hybrid `edit` tool at registration time (custom tools override
 * built-ins by name).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initHasher } from "../anchors/hasher";
import { loadStore, shutdownStore } from "../state/database";
import { runRecovery } from "../state/recovery";
import { resetServed } from "../served/ledger";

export function registerSession(pi: ExtensionAPI, autoReadState: { value: boolean }): void {
  pi.on("session_start", async (_event, ctx) => {
    try {
      await initHasher();
    } catch (error) {
      // Tools that need anchor allocation fail closed with a clear error;
      // the store and served-state reset must still run.
      console.error("Hashline xxhash-wasm initialization failed:", error);
    }
    try {
      const store = await loadStore();
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
