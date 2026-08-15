/**
 * pi-hashline-edit-hybrid — fail-closed, hash-anchored text mutation for
 * Pi coding agents (spec §1).
 *
 * Tools: read, grep, edit, insert, undo. The generic pi `edit` tool is
 * replaced by the hybrid `edit` tool (custom tools override built-ins by
 * name). A successful `write` triggers anchor reconciliation and an
 * optional auto-read preview.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "./src/tools/read";
import { registerGrepTool } from "./src/tools/grep";
import { registerEditTool } from "./src/tools/edit";
import { registerInsertTool } from "./src/tools/insert";
import { registerUndoTool } from "./src/tools/undo";
import { registerWriteHook } from "./src/integration/write-hook";
import { registerSession } from "./src/integration/session";

export default function (pi: ExtensionAPI): void {
  const autoReadState = { value: true };
  registerReadTool(pi);
  registerGrepTool(pi);
  registerEditTool(pi);
  registerInsertTool(pi);
  registerUndoTool(pi);
  registerWriteHook(pi, () => autoReadState.value);
  registerSession(pi, autoReadState);
}
