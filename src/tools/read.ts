/**
 * `read` tool (spec §12, §25, §27).
 *
 * Returns complete lines with `anchor│text` rows. Read guarantees: resolve
 * symlink targets consistently, validate file type, reject unsupported
 * encodings, reconcile the persistent anchor state, return complete lines
 * up to the display limit, and record only fully rendered lines as served.
 * The current revision (SHA-256 of raw bytes) is exposed in details for
 * `expected_revision` CAS mode.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toCwd } from "../paths";
import { abortIf } from "../utils";
import { DEFAULT_READ_LIMIT } from "../constants";
import { resolveTarget } from "../filesystem/resolve-target";
import { loadAnchoredFile } from "../mutation/transaction";
import { renderLines } from "../render/hashline";

export interface ReadToolDetails {
  revision: string;
  totalLines: number;
  shownLines: number;
  nextOffset?: number;
}

const readSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to read" }),
    offset: Type.Optional(
      Type.Integer({ minimum: 1, description: "1-indexed line to start from" }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, description: "Maximum number of lines to return" }),
    ),
  },
  { additionalProperties: false },
);

const R_DESC = `Read a text file with stable 4-character hash anchors. Every returned row is \`anchor│content\`; the anchors are edit-ready — use them with edit, insert, and grep without re-reading. Output is paged: without \`limit\`, at most ${DEFAULT_READ_LIMIT} lines are returned (use \`offset\` to continue). Lines too large to display are omitted with a note and are not editable until inspected.`;

const R_SNIPPET =
  "read: return file lines with stable `ANCHOR│content` rows; anchors are edit-ready and become authorized for destructive edits.";

const R_GUIDELINES = [
  "Only lines actually shown in a tool result become editable; after a session restart, re-read before editing.",
  "Use offset/limit for paging; the returned anchors stay valid across pagination.",
];

function normPosInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`[E_BAD_SHAPE] Read request field "${name}" must be a positive integer.`);
  }
  return value;
}

export function buildReadToolDef(): ToolDefinition<any, ReadToolDetails> {
  return {
    name: "read",
    label: "Read",
    description: R_DESC,
    promptSnippet: R_SNIPPET,
    promptGuidelines: R_GUIDELINES,
    parameters: readSchema,

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as Record<string, unknown>;
      if (typeof params?.path !== "string" || params.path.length === 0) {
        throw new Error('[E_BAD_SHAPE] A non-empty "path" string is required.');
      }
      const offset = normPosInt(params.offset, "offset");
      const limit = normPosInt(params.limit, "limit");
      const requestPath = params.path;
      const absolutePath = toCwd(requestPath, ctx.cwd);
      const realPath = await resolveTarget(absolutePath);
      abortIf(signal);

      const file = await loadAnchoredFile(realPath, requestPath);
      const total = file.texts.length;

      if ((offset ?? 1) > total) {
        return {
          content: [
            {
              type: "text",
              text: `Offset ${offset} is beyond end of file (${total} lines total). Use offset=1 to read from the start.`,
            },
          ],
          details: { revision: file.checksum, totalLines: total, shownLines: 0 },
        };
      }

      const start = (offset ?? 1) - 1;
      const end = Math.min(start + (limit ?? DEFAULT_READ_LIMIT), total);
      const { text, served } = renderLines(realPath, file.anchors, file.texts, start, end);

      let output = text;
      let nextOffset: number | undefined;
      if (total === 1 && file.texts[0] === "" && file.raw.length === 0) {
        output = `${text}\n[File is empty. Use edit or insert to add content.]`;
      } else if (end < total) {
        nextOffset = end + 1;
        output += `\n\n[Showing lines ${start + 1}-${end} of ${total}. Use offset=${nextOffset} to continue.]`;
      } else if (total > 1) {
        output += `\n\n[Showing lines ${start + 1}-${end} of ${total}.]`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: {
          revision: file.checksum,
          totalLines: total,
          shownLines: served.length,
          ...(nextOffset !== undefined ? { nextOffset } : {}),
        },
      };
    },
  };
}

export function registerReadTool(pi: ExtensionAPI): void {
  pi.registerTool(buildReadToolDef());
}
