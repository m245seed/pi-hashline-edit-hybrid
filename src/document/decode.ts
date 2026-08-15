/** Document decode/encode: raw bytes <-> anchored line model. */

import { decodeText } from "./encoding";
import { splitTextLines, joinTextLines, type Document } from "./lines";

/**
 * Decode raw file bytes into a Document. A zero-byte file becomes a single
 * empty logical line so the anchored protocol is total. BOM is metadata, not
 * line 1 (spec §42).
 */
export function decodeDocument(raw: Uint8Array, pathLabel: string): Document {
  const { bom, text } = decodeText(raw, pathLabel);
  return { bom, lines: splitTextLines(text) };
}

/**
 * Encode a Document back to raw bytes. This is the only place BOM and line
 * terminators are recombined; untouched lines keep their exact terminators.
 */
export function encodeDocument(doc: Document): string {
  return doc.bom + joinTextLines(doc.lines);
}

export function documentText(doc: Document): string {
  return joinTextLines(doc.lines);
}
