/**
 * Integration with external `write` results (spec §37, §38, §42, PH-WRITE-002).
 *
 * When a write succeeds OUTSIDE hashline (e.g. another extension or a
 * fallback built-in write), it is an authoritative whole-file mutation:
 * clear hybrid undo for that file, reconcile/regenerate the anchor mapping,
 * retire removed anchors, invalidate served authorization for lines that no
 * longer match, and (with auto-read enabled, the default) return an anchored
 * preview — which also records served state. A failed write must not clear
 * undo, so the hook only runs on successful results.
 *
 * Results produced by hashline's own `write` tool carry a
 * `details.hashline` marker and are skipped: that tool already reconciles
 * anchors, records undo, and returns a bounded preview. The auto-read
 * preview is bounded by an independent 100-line default plus a total byte
 * cap (PH-WRITE-002).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toCwd } from "../paths";
import { resolveTarget } from "../filesystem/resolve-target";
import { loadAnchoredFile } from "../mutation/transaction";
import { clearUndoRecord } from "../state/undo";
import { pruneServedPath, serveLines } from "../served/ledger";
import { renderLinesBounded } from "../render/hashline";
import { AUTO_READ_MAX_LINES, AUTO_READ_MAX_BYTES } from "../constants";

function isOwnHashlineWrite(event: { details?: unknown }): boolean {
  const details = event.details as { hashline?: { protocol?: unknown } } | undefined;
  return details?.hashline?.protocol === "pi-hashline-result/1";
}

export function registerWriteHook(
  pi: ExtensionAPI,
  getAutoRead: () => boolean,
): void {
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName !== "write") return;
    // Hashline's own write tool already reconciled and previewed.
    if (isOwnHashlineWrite(event)) return;
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
      const preview = renderLinesBounded(
        file.anchors,
        file.texts,
        0,
        end,
        AUTO_READ_MAX_BYTES,
      );
      serveLines(realPath, preview.served);
      let previewText = preview.text;
      if (preview.truncated) {
        previewText += `\n\n[Preview truncated at the ${AUTO_READ_MAX_BYTES / 1024}KB budget. Use read to see more.]`;
      } else if (end < file.texts.length) {
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
