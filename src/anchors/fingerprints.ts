/**
 * Line fingerprints (spec §4.2, §65).
 *
 * The served-state system compares exact line contents. Fingerprints are
 * SHA-256 of the exact logical line text (UTF-8); trailing whitespace is
 * significant — `"return x;"` and `"return x; "` are different served
 * states. Fingerprints are only used as a compact persisted representation
 * of line identity for reconciliation; in-memory comparisons use the exact
 * text directly.
 */

import { createHash } from "crypto";

export const FINGERPRINT_BYTES = 32;

export function lineFingerprintHex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export function decodeFingerprintHexes(blob: Uint8Array): string[] {
  if (blob.length % FINGERPRINT_BYTES !== 0) {
    throw new Error("Corrupt fingerprint blob length");
  }
  const out: string[] = [];
  for (let i = 0; i < blob.length; i += FINGERPRINT_BYTES) {
    out.push(Buffer.from(blob.subarray(i, i + FINGERPRINT_BYTES)).toString("hex"));
  }
  return out;
}

export function fingerprintHexes(texts: string[]): string[] {
  return texts.map(lineFingerprintHex);
}
