/**
 * Structured result metadata (spec §31.1 PH-PROTO-003, §19.1).
 *
 * Every returned hashline result carries a `details.hashline` object. It
 * declares the result protocol, the canonical outcome, and the
 * render-then-serve exact-content marker that Sentinel uses to bypass live
 * content redaction (PS-SEC-011) and to classify the result without parsing
 * prose.
 */

import { getContextEpoch } from "../served/epoch";
import { HASHLINE_PROTOCOL_ID, HASHLINE_RESULT_PROTOCOL } from "../integration/protocol";

/** Canonical Sentinel outcome vocabulary (mirrors Sentinel, no import). */
export type HashlineOutcome =
  | "success"
  | "no_change"
  | "no_match"
  | "partial_success"
  | "rejected"
  | "cancelled"
  | "timed_out"
  | "retryable_error"
  | "fatal_error";

export interface HashlineResultDetails {
  protocol: typeof HASHLINE_RESULT_PROTOCOL;
  toolProtocol: typeof HASHLINE_PROTOCOL_ID;
  outcome: HashlineOutcome;
  code: string;
  exactContent: boolean;
  renderThenServe: boolean;
  contextEpoch: number;
  /** Number of complete exact rows retained in the final result. */
  servedRows?: number;
  /** Alias consumed by Sentinel's exact-output marker (§19.1). */
  servedRowCount?: number;
  transactionId?: string;
  fileSha256?: string;
  warnings?: string[];
}

export interface HashlineDetailsInput {
  outcome: HashlineOutcome;
  code: string;
  /**
   * Whether the result carries exact file rows the model may rely on.
   * Defaults to true for read/grep/edit/insert/undo/write output.
   */
  exactContent?: boolean;
  servedRows?: number;
  transactionId?: string;
  fileSha256?: string;
  warnings?: string[];
}
export function hashlineDetails(input: HashlineDetailsInput): HashlineResultDetails {
  const details: HashlineResultDetails = {
    protocol: HASHLINE_RESULT_PROTOCOL,
    toolProtocol: HASHLINE_PROTOCOL_ID,
    outcome: input.outcome,
    code: input.code,
    exactContent: input.exactContent ?? true,
    renderThenServe: true,
    contextEpoch: getContextEpoch(),
  };
  if (input.servedRows !== undefined) {
    details.servedRows = input.servedRows;
    details.servedRowCount = input.servedRows;
  }
  if (input.transactionId !== undefined) details.transactionId = input.transactionId;
  if (input.fileSha256 !== undefined) details.fileSha256 = input.fileSha256;
  if (input.warnings !== undefined && input.warnings.length > 0) {
    details.warnings = input.warnings;
  }
  return details;
}
