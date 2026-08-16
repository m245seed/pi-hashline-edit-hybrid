/**
 * Inter-extension IPC (spec §12, §31.11).
 *
 * Hashline speaks the versioned `pi-sentinel-hashline/1` envelope protocol on
 * Pi's shared event bus:
 *
 * - answers `pi-sentinel.ipc.v1.discover` with a capability announcement;
 * - emits mutation.before / mutation.after / mutation.rejected / undo.after /
 *   context.epoch without depending on a reply;
 * - honors freeze/unfreeze requests (specific freeze IDs only);
 * - advances the served-authorization epoch on Sentinel context-advance.
 *
 * Hashline MUST keep functioning safely when Sentinel is absent: every emit
 * is a no-op without a bus, and its own default strict safety applies
 * regardless (PH §31.11). Unsupported protocol majors and unknown senders
 * are ignored (PS-IPC-001).
 */

import { createHash, randomUUID } from "crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ALPH, HASH_SEP, ANCHOR_LEN } from "../anchors/alphabet";
import { getContextEpoch, setContextEpoch } from "../served/epoch";
import { addFreeze, removeFreeze } from "./freeze";
import { READ_MAX_OUTPUT_BYTES, MAX_LINES } from "../constants";

const IPC_PROTOCOL_ID = "pi-sentinel-hashline/1";
const HASHLINE_PROTOCOL_ID = "pi-hashline/1";
const PACKAGE_NAME = "pi-hashline-edit-hybrid";
const PACKAGE_VERSION = "0.1.0";

const EVENTS = {
  sentinelDiscover: "pi-sentinel.ipc.v1.discover",
  hashlineAnnounce: "pi-hashline.ipc.v1.announce",
  hashlineMutationBefore: "pi-hashline.ipc.v1.mutation.before",
  hashlineMutationAfter: "pi-hashline.ipc.v1.mutation.after",
  hashlineMutationRejected: "pi-hashline.ipc.v1.mutation.rejected",
  hashlineUndoAfter: "pi-hashline.ipc.v1.undo.after",
  hashlineContextEpoch: "pi-hashline.ipc.v1.context.epoch",
  sentinelContextAdvance: "pi-sentinel.ipc.v1.context.advance",
  sentinelFreeze: "pi-sentinel.ipc.v1.freeze",
  sentinelUnfreeze: "pi-sentinel.ipc.v1.unfreeze",
} as const;

interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface IpcEnvelope<TPayload = unknown> {
  protocol: string;
  type: string;
  requestId?: string;
  replyTo?: string;
  sentAt: string;
  sessionId?: string;
  sender: {
    packageName: string;
    packageVersion: string;
    runtimeId: string;
    generation: number;
  };
  payload: TPayload;
}

export interface HashlineMutationEvent {
  transactionId: string;
  toolCallId: string;
  path: string;
  operation: "edit" | "insert" | "write" | "undo";
  editCount: number;
  removedLines: number;
  addedLines: number;
  beforeSha256: string;
  afterSha256?: string;
  contextEpoch: number;
  outcome: string;
  warningCodes: string[];
}

export interface HashlineUndoEvent {
  transactionId: string;
  toolCallId: string;
  success: boolean;
  code?: string;
}

interface AnnounceTool {
  name: string;
  role: string;
  schemaDigest: string;
  resultProtocol: string;
  exactContent: boolean;
}

interface HashlineAnnouncement {
  protocolId: typeof HASHLINE_PROTOCOL_ID;
  anchorFormat: { width: number; separator: string; alphabet: string };
  tools: AnnounceTool[];
  features: {
    servedAuthorization: boolean;
    atomicMultiEdit: boolean;
    boundaryDuplicateBlock: boolean;
    largeDestructiveGuard: boolean;
    safeWriteOverride: boolean;
    persistentUndo: boolean;
    contextEpochs: boolean;
    boundedExactRendering: boolean;
  };
  outputContract: {
    exactRowsMarkedInDetails: boolean;
    renderThenServe: boolean;
    maxBytes: number;
    maxLines: number;
  };
}

// ── Canonical schema digest (must match Sentinel §13.2) ────────────────

const IGNORE_KEYS = new Set(["examples", "$comment"]);

function normalizeNumber(value: number): number {
  if (Number.isNaN(value)) return Number.NaN;
  return value === 0 ? 0 : value;
}

function prepare(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return normalizeNumber(value);
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(prepare);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (IGNORE_KEYS.has(key)) continue;
      result[key.normalize("NFC")] = prepare(item);
    }
    return result;
  }
  return String(value);
}

function canonicalSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return '"NaN"';
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSerialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalSerialize((value as Record<string, unknown>)[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  return "null";
}

export function digestSchema(schema: unknown): string {
  const canonical = canonicalSerialize(prepare(schema));
  const hex = createHash("sha256").update(canonical, "utf-8").digest("hex");
  return `sha256:${hex}`;
}

// ── Runtime state ──────────────────────────────────────────────────────

let bus: EventBusLike | undefined;
let sessionId: string | undefined;
const runtimeId = randomUUID();
let generation = 1;
let announcement: HashlineAnnouncement | undefined;
const unsubscribers: Array<() => void> = [];

function createEnvelope<TPayload>(
  type: string,
  payload: TPayload,
  options: { requestId?: string; replyTo?: string } = {},
): IpcEnvelope<TPayload> {
  return {
    protocol: IPC_PROTOCOL_ID,
    type,
    requestId: options.requestId,
    replyTo: options.replyTo,
    sentAt: new Date().toISOString(),
    sessionId,
    sender: {
      packageName: PACKAGE_NAME,
      packageVersion: PACKAGE_VERSION,
      runtimeId,
      generation,
    },
    payload,
  };
}

function parseEnvelope(data: unknown): IpcEnvelope | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const envelope = data as IpcEnvelope;
  // PS-IPC-001: ignore unsupported major protocol versions.
  if (envelope.protocol !== IPC_PROTOCOL_ID) return undefined;
  if (typeof envelope.type !== "string" || envelope.type.length === 0) return undefined;
  if (typeof envelope.sentAt !== "string") return undefined;
  if (typeof envelope.sender !== "object" || envelope.sender === null) return undefined;
  if (envelope.sender.packageName !== "pi-sentinel") return undefined;
  return envelope;
}

function emit(type: string, payload: unknown, options: { replyTo?: string } = {}): void {
  if (!bus) return;
  try {
    bus.emit(type, createEnvelope(type, payload, options));
  } catch {
    // Emitting must never break a mutation.
  }
}

// ── Public emitters (no-ops when Sentinel/the bus is absent) ───────────

export function emitMutationBefore(event: HashlineMutationEvent): void {
  emit(EVENTS.hashlineMutationBefore, event);
}

export function emitMutationAfter(event: HashlineMutationEvent): void {
  emit(EVENTS.hashlineMutationAfter, event);
}

export function emitMutationRejected(event: HashlineMutationEvent): void {
  emit(EVENTS.hashlineMutationRejected, event);
}

export function emitUndoAfter(event: HashlineUndoEvent): void {
  emit(EVENTS.hashlineUndoAfter, event);
}

export function emitContextEpoch(reason?: string): void {
  emit(EVENTS.hashlineContextEpoch, { epoch: getContextEpoch(), reason });
}

/** Build the current epoch-scoped mutation event fields. */
export function mutationEventBase(input: {
  transactionId: string;
  toolCallId: string;
  path: string;
  operation: HashlineMutationEvent["operation"];
  editCount: number;
  removedLines: number;
  addedLines: number;
  beforeSha256: string;
  afterSha256?: string;
  outcome: string;
  warningCodes?: string[];
}): HashlineMutationEvent {
  return {
    transactionId: input.transactionId,
    toolCallId: input.toolCallId,
    path: input.path,
    operation: input.operation,
    editCount: input.editCount,
    removedLines: input.removedLines,
    addedLines: input.addedLines,
    beforeSha256: input.beforeSha256,
    afterSha256: input.afterSha256,
    contextEpoch: getContextEpoch(),
    outcome: input.outcome,
    warningCodes: input.warningCodes ?? [],
  };
}

// ── Registration ───────────────────────────────────────────────────────

const TOOL_ROLES: Record<string, string> = {
  read: "anchored_read",
  grep: "anchored_search",
  edit: "anchored_edit",
  insert: "anchored_insert",
  write: "safe_write",
  undo: "file_undo",
};

export interface IpcToolDef {
  name: string;
  parameters: unknown;
}

export function registerIpc(pi: ExtensionAPI, tools: IpcToolDef[]): void {
  const events = (pi as unknown as { events?: EventBusLike }).events;
  if (!events) return;
  bus = events;

  announcement = {
    protocolId: HASHLINE_PROTOCOL_ID,
    anchorFormat: { width: ANCHOR_LEN, separator: HASH_SEP, alphabet: ALPH },
    tools: tools
      .filter((tool) => TOOL_ROLES[tool.name])
      .map((tool) => ({
        name: tool.name,
        role: TOOL_ROLES[tool.name]!,
        schemaDigest: digestSchema(tool.parameters),
        resultProtocol: "pi-hashline-result/1",
        exactContent: true,
      })),
    features: {
      servedAuthorization: true,
      atomicMultiEdit: true,
      boundaryDuplicateBlock: true,
      largeDestructiveGuard: true,
      safeWriteOverride: true,
      persistentUndo: true,
      contextEpochs: true,
      boundedExactRendering: true,
    },
    outputContract: {
      exactRowsMarkedInDetails: true,
      renderThenServe: true,
      maxBytes: READ_MAX_OUTPUT_BYTES,
      maxLines: MAX_LINES,
    },
  };

  unsubscribers.push(
    events.on(EVENTS.sentinelDiscover, (data) => {
      const envelope = parseEnvelope(data);
      if (!envelope || !announcement) return;
      emit(EVENTS.hashlineAnnounce, announcement, { replyTo: envelope.requestId });
    }),
  );

  unsubscribers.push(
    events.on(EVENTS.sentinelFreeze, (data) => {
      const envelope = parseEnvelope(data);
      if (!envelope) return;
      const payload = envelope.payload as {
        freezeId?: string;
        reasonCode?: string;
        expiresAt?: string;
      };
      if (typeof payload?.freezeId !== "string") return;
      addFreeze({
        freezeId: payload.freezeId,
        reasonCode: typeof payload.reasonCode === "string" ? payload.reasonCode : "UNKNOWN",
        expiresAt: payload.expiresAt,
        receivedAt: new Date().toISOString(),
      });
    }),
  );

  unsubscribers.push(
    events.on(EVENTS.sentinelUnfreeze, (data) => {
      const envelope = parseEnvelope(data);
      if (!envelope) return;
      const payload = envelope.payload as { freezeId?: string };
      // §12.5: unfreeze MUST name a specific freeze ID.
      if (typeof payload?.freezeId !== "string") return;
      removeFreeze(payload.freezeId);
    }),
  );

  unsubscribers.push(
    events.on(EVENTS.sentinelContextAdvance, (data) => {
      const envelope = parseEnvelope(data);
      if (!envelope) return;
      const payload = envelope.payload as { reason?: string; epoch?: number };
      if (typeof payload?.epoch === "number") {
        setContextEpoch(payload.epoch);
      }
      emitContextEpoch(payload?.reason ?? "sentinel-context-advance");
    }),
  );
}

export function unregisterIpc(): void {
  for (const unsubscribe of unsubscribers) {
    try {
      unsubscribe();
    } catch {
      // Ignore.
    }
  }
  unsubscribers.length = 0;
  bus = undefined;
  sessionId = undefined;
}

/** Test helper: bump the runtime generation (simulates reload). */
export function bumpGenerationForTests(): void {
  generation++;
}

/** Test helper: set the session id stamped on envelopes. */
export function setSessionIdForTests(id: string | undefined): void {
  sessionId = id;
}
