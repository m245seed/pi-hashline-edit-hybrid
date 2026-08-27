/**
 * `write` tool — hashline-owned safe write override (spec §31.8,
 * PH-WRITE-001/002/003, PH-PROTO-001..003).
 *
 * Replaces the generic built-in `write` so a whole-file overwrite can no
 * longer silently bypass served authorization:
 *
 * - New files: permitted with size/path policy and an atomic write.
 * - Existing files: require either explicit full-file read authorization in
 *   the current context epoch, or `replace_existing: true` as an explicit *   high-risk override.
 *
 * The write participates in the file mutation queue, creates undo/journal
 * records, reconciles anchors only after a successful atomic commit, and
 * returns a bounded anchored preview (PH-WRITE-002).
 */

import { stat as fsStat } from "fs/promises";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { abortIf, debugLog, errCode, isRec, rejectUnknownFields, sha256Hex } from "../utils";
import { withFileMutationQueue } from "../filesystem/resolve-target";
import { resolveMutationTarget, renderAutoReadPreview } from "./shared";
import {
  MAX_BYTES,
  MAX_LINES,
  HASHLINE_PROTOCOL_ID,
} from "../constants";
import { decodeDocument, encodeDocument } from "../document/encoding";
import type { Document } from "../document/lines";
import { AnchorAllocator } from "../anchors/allocator";
import { fingerprintHexes } from "../anchors/fingerprints";
import { reconcileState } from "../anchors/reconcile";
import {
  loadAnchoredFile,
  commitMutation,
  anchorSpaceWarning,
} from "../mutation/transaction";
import { newTransactionId } from "../state/transaction-journal";
import { suspiciousContentCheck, WRITE_ROOT_KEYS, LONE_SURROGATE_RE } from "../mutation/validate";
import { checkRangeServed, formatRangeFailure } from "../served/authorize";
import { pruneServedPath } from "../served/ledger";
import { hashlineDetails } from "../render/result-details";
export interface WriteToolDetails {
  revision: string;
  totalLines: number;
  shownLines: number;
  created: boolean;
  hashline: ReturnType<typeof hashlineDetails>;
}

// Authoritative checks in src/mutation/validate.ts
const writeSchema = Type.Object(
  {
    path: Type.String({ description: "Path of the file to write" }),
    content: Type.String({
      description:
        "The complete literal file content. For an existing file this replaces every byte.",
    }),
    replace_existing: Type.Optional(
      Type.Boolean({
        description:
          "When true, overwrite an existing file without requiring full-file read authorization. High-risk: the previous content is replaced wholesale.",
      }),
    ),
    allow_display_like_content: Type.Optional(
      Type.Boolean({
        description:
          "When true, write content that looks like pasted hashline display output (ANCHOR│... rows) literally instead of rejecting it with E_DISPLAY_LIKE_CONTENT.",
      }),
    ),
    expected_revision: Type.Optional(
      Type.String({
        description:
          "When provided, the write fails if the current file revision differs (CAS mode).",
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

const W_DESC = `Protocol-ID: ${HASHLINE_PROTOCOL_ID} (anchor width 4). Write the complete content of a file atomically. Creating a NEW file is permitted. Overwriting an EXISTING file requires that you have already read the entire file in this session (so you know what you are replacing), or the explicit high-risk flag replace_existing=true. Returns a bounded anchored preview of the written file.`;

const W_SNIPPET =
  "write: atomically create or fully replace a file; overwriting an existing file requires full-file read authorization or replace_existing=true.";

const W_GUIDELINES = [
  "Prefer edit/insert for partial changes; write replaces the whole file and discards any lines you omit.",
  "Only overwrite a file you have fully read this session, or pass replace_existing=true deliberately.",
  "Content resembling pasted hashline output is rejected with E_DISPLAY_LIKE_CONTENT; pass allow_display_like_content: true only for genuinely literal content.",
];


function encodeContent(content: string): { doc: Document; raw: Buffer } {
  const doc = decodeDocument(Buffer.from(content, "utf-8"), "write content");
  const raw = Buffer.from(encodeDocument(doc), "utf-8");
  return { doc, raw };
}

export function buildWriteToolDef(): ToolDefinition<any, WriteToolDetails> {
  return {
    name: "write",
    label: "Write",
    description: W_DESC,
    promptSnippet: W_SNIPPET,
    promptGuidelines: W_GUIDELINES,
    parameters: writeSchema,
    executionMode: "sequential",

    async execute(toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as Record<string, unknown>;
      if (!isRec(params)) {
        throw new Error('[E_BAD_SHAPE] write parameters must be an object.');
      }
      rejectUnknownFields(params, WRITE_ROOT_KEYS, "write request");
      if (typeof params.path !== "string" || params.path.length === 0) {
        throw new Error('[E_BAD_SHAPE] A non-empty "path" string is required.');
      }
      if (typeof params.content !== "string") {
        throw new Error('[E_BAD_SHAPE] A "content" string is required.');
      }
      if (
        params.replace_existing !== undefined &&
        typeof params.replace_existing !== "boolean"
      ) {
        throw new Error('[E_BAD_SHAPE] "replace_existing" must be a boolean.');
      }
      if (
        params.allow_display_like_content !== undefined &&
        typeof params.allow_display_like_content !== "boolean"
      ) {
        throw new Error('[E_BAD_SHAPE] "allow_display_like_content" must be a boolean.');
      }
      if (
        params.expected_revision !== undefined &&
        !(typeof params.expected_revision === "string" && /^[0-9a-f]{64}$/.test(params.expected_revision))
      ) {
        throw new Error(
          '[E_BAD_SHAPE] "expected_revision" must be a 64-character lowercase SHA-256 hex revision.',
        );
      }
      const requestPath = params.path;
      const content = params.content;
      const replaceExisting = params.replace_existing === true;
      const expectedRevision = params.expected_revision as string | undefined;
      const allowDisplayLike = params.allow_display_like_content === true;

      const mutationTargetPath = await resolveMutationTarget(requestPath, ctx.cwd);
      return runWrite({
        toolCallId,
        requestPath,
        mutationTargetPath,
        content,
        replaceExisting,
        expectedRevision,
        allowDisplayLike,
        signal,
      });
    },
  };
}

interface RunWriteInput {
  toolCallId: string;
  requestPath: string;
  mutationTargetPath: string;
  content: string;
  replaceExisting: boolean;
  expectedRevision?: string;
  allowDisplayLike: boolean;
  signal?: AbortSignal;
}

async function runWrite(input: RunWriteInput): Promise<ReturnType<ToolDefinition<any, WriteToolDetails>["execute"]>> {
  const {
    requestPath,
    mutationTargetPath,
    content,
    replaceExisting,
    expectedRevision,
    allowDisplayLike,
    signal,
  } = input;

  return withFileMutationQueue(mutationTargetPath, async () => {

    // Size / shape policy (PH-WRITE, §31.8).
    if (LONE_SURROGATE_RE.test(content)) {
      throw new Error(
        '[E_BAD_SHAPE] "content" contains an unpaired UTF-16 surrogate and cannot be written as UTF-8.',
      );
    }
    const rawByteLength = Buffer.byteLength(content, "utf-8");
    if (rawByteLength > MAX_BYTES) {
      throw new Error(
        `[E_FILE_TOO_LARGE] The requested content is ${rawByteLength} bytes, exceeding the ${MAX_BYTES} byte write limit. Nothing was modified.`,
      );
    }
    const { doc: docAfter, raw: rawAfter } = encodeContent(content);
    if (docAfter.lines.length > MAX_LINES) {
      throw new Error(
        `[E_FILE_TOO_LARGE] The requested content has ${docAfter.lines.length} lines, exceeding the ${MAX_LINES} line limit. Nothing was modified.`,
      );
    }
    const afterChecksum = sha256Hex(rawAfter);
    const newTexts = docAfter.lines.map((line) => line.text);
    const newFingerprints = fingerprintHexes(newTexts);
    // Reject pasted hashline display output (spec §17): raw content containing
    // anchor|text rows is almost certainly a copy-paste error. The
    // allow_display_like_content escape hatch mirrors edit/insert.
    for (const line of newTexts) {
      suspiciousContentCheck(line, allowDisplayLike);
    }

    abortIf(signal);
    // Does the target already exist?
    let isNew = false;
    try {
      await fsStat(mutationTargetPath);
    } catch (error: unknown) {
      if (errCode(error) === "ENOENT") {
        isNew = true;
      } else {
        throw error;
      }
    }

    let rawBefore: Buffer;
    let checksumBefore: string;
    let docBefore: Document;
    let anchorsBefore: string[];
    let fingerprintsBefore: string[];
    let retiredBefore: Set<string>;
    let anchorsAfter: string[];
    let retiredAfter: Set<string>;

    if (isNew) {
      rawBefore = Buffer.alloc(0);
      checksumBefore = sha256Hex(rawBefore);
      // Zero-byte-file convention: the previous state is one empty logical
      // line with its anchor, so undo of a create restores a consistent
      // empty-file state (doc.lines, anchors, and fingerprints stay aligned).
      docBefore = { bom: "", lines: [{ text: "", eol: "" }] };
      const allocator = new AnchorAllocator(new Set<string>(), new Set<string>());
      anchorsBefore = [allocator.allocate("")];
      fingerprintsBefore = fingerprintHexes([""]);
      retiredBefore = new Set<string>();
      anchorsAfter = newTexts.map((text) => allocator.allocate(text));
      retiredAfter = new Set<string>();
    } else {
      const file = await loadAnchoredFile(mutationTargetPath, requestPath);
      rawBefore = file.raw;
      checksumBefore = file.checksum;
      docBefore = file.doc;
      anchorsBefore = file.anchors;
      fingerprintsBefore = file.fingerprints;
      retiredBefore = file.retired;

      // PH-WRITE-001: overwriting an existing file requires full-file read
      // authorization in the current epoch, unless explicitly overridden.
      if (!replaceExisting) {
        const check = checkRangeServed(
          mutationTargetPath,
          file.anchors,
          file.texts,
          0,
          file.texts.length - 1,
        );
        if (!check.ok) {
          throw new Error(
            `${formatRangeFailure(
              requestPath,
              mutationTargetPath,
              file.anchors,
              file.texts,
              0,
              file.texts.length - 1,
              check,
            )}\n\nTo replace this file anyway, resend with "replace_existing": true.`,
          );
        }
      }

      // Reconcile anchors against the new content (preserves unchanged lines).
      const reconciled = reconcileState(
        { anchors: file.anchors, fingerprints: file.fingerprints },
        file.retired,
        newTexts,
        newFingerprints,
      );
      anchorsAfter = reconciled.anchors;
      retiredAfter = new Set([...file.retired, ...reconciled.retiredAdded]);
    }

    const warnings: string[] = [];
    const pressure = anchorSpaceWarning(new Set(anchorsAfter).size, retiredAfter.size);
    if (pressure) warnings.push(pressure);

    const transactionId = newTransactionId();

    abortIf(signal);
    await commitMutation({
      realPath: mutationTargetPath,
      label: requestPath,
      rawBefore,
      checksumBefore,
      docBefore,
      anchorsBefore,
      fingerprintsBefore,
      retiredBefore,
      rawAfter,
      checksumAfter: afterChecksum,
      docAfter,
      anchorsAfter,
      fingerprintsAfter: newFingerprints,
      retiredAfter,
      transactionId,
      signal,
      expectedRevision,
      keepUndo: true,
      warnings,
      expectAbsent: isNew,
    });

    // Reconcile anchors/served state only after a successful commit (§31.8).
    const current = new Map<string, string>();
    for (let i = 0; i < anchorsAfter.length; i++) {
      current.set(anchorsAfter[i]!, newTexts[i]!);
    }
    pruneServedPath(mutationTargetPath, current);

    // Bounded anchored preview (PH-WRITE-002).
    const { text: previewText, servedRows: previewRows } = renderAutoReadPreview(
      anchorsAfter,
      newTexts,
      mutationTargetPath,
    );

    debugLog("write committed", { path: mutationTargetPath, warnings });

    const heading = isNew
      ? `Created ${requestPath} (${newTexts.length} line(s)).`
      : `Wrote ${requestPath} (${newTexts.length} line(s)).`;
    const text = `${heading}\n\n${previewText}`;

    return {
      content: [{ type: "text", text }],
      details: {
        revision: afterChecksum,
        totalLines: newTexts.length,
        shownLines: previewRows,
        created: isNew,
        hashline: hashlineDetails({
          outcome: "success",
          code: "OK",
          transactionId,
          fileSha256: afterChecksum,
          servedRows: previewRows,
          warnings,
        }),
      },
    };
  });
}
