/**
 * Integration with `write` (spec §37, §38, §42).
 *
 * A successful generic `write` is an authoritative whole-file mutation:
 * clear hybrid undo for that file, reconcile/regenerate the anchor mapping,
 * retire removed anchors, invalidate served authorization for lines that no
 * longer match, and (with auto-read enabled, the default) return an
 * anchored preview — which also records served state. A failed write must
 * not clear undo, so the hook only runs on successful results.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toCwd } from "../paths";
import { resolveTarget } from "../filesystem/resolve-target";
import { loadAnchoredFile } from "../mutation/transaction";
import { clearUndoRecord } from "../state/undo";
import { pruneServedPath } from "../served/ledger";
import { renderLines } from "../render/hashline";
import { AUTO_READ_MAX_LINES } from "../constants";

export function registerWriteHook(
  pi: ExtensionAPI,
  getAutoRead: () => boolean,
): void {
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName !== "write") return;
    const writtenPath = (event.input as Record<string, unknown>)?.path;
    if (typeof writtenPath !== "string") return;

    try {
      const realPath = await resolveTarget(toCwd(writtenPath, ctx.cwd));
      // Authoritative whole-file mutation: clear undo and re-anchor.
      await clearUndoRecord(realPath);
      const file = await loadAnchoredFile(realPath, writtenPath);
      const current = new Map<string, string>();
      for (let i = 0; i < file.anchors.length; i++) {
        current.set(file.anchors[i]!, file.texts[i]!);
      }
      pruneServedPath(realPath, current);

      if (!getAutoRead()) return;
      const end = Math.min(file.texts.length, AUTO_READ_MAX_LINES);
      const preview = renderLines(realPath, file.anchors, file.texts, 0, end);
      let previewText = preview.text;
      if (end < file.texts.length) {
        previewText += `\n\n[Showing the first ${end} lines of ${file.texts.length}.]`;
      }
      return {
        content: [
          ...(event.content ?? []),
          { type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${previewText}` },
        ],
      };
    } catch (error) {
      console.error("Auto-read after write failed:", error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          ...(event.content ?? []),
          { type: "text", text: `\n\n--- Auto-read failed: ${message} ---` },
        ],
      };
    }
  });
}
