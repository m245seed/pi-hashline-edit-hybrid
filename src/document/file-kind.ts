/**
 * File-kind checks and resource limits (spec §12, §53).
 *
 * The hybrid is stricter than the pro implementation: only regular text
 * files are readable; directories, non-regular files, oversized files, and
 * binary content are rejected before any decoding happens.
 */

import { stat } from "fs/promises";
import { MAX_BYTES, MAX_LINES } from "../constants";
import { formatSize } from "../utils";

export type FileKind =
  | { kind: "ok"; size: number }
  | { kind: "directory" }
  | { kind: "not_file" }
  | { kind: "too_large"; size: number };

export async function checkFileKind(
  filePath: string,
  label: string,
): Promise<FileKind> {
  const info = await stat(filePath);
  if (info.isDirectory()) {
    return { kind: "directory" };
  }
  if (!info.isFile()) {
    return { kind: "not_file" };
  }
  if (info.size > MAX_BYTES) {
    return { kind: "too_large", size: info.size };
  }
  return { kind: "ok", size: info.size };
}

export function assertFileKind(kind: FileKind, label: string): void {
  if (kind.kind === "directory") {
    throw new Error(`[E_BAD_REF] ${label} is a directory, not a file.`);
  }
  if (kind.kind === "not_file") {
    throw new Error(`[E_BAD_REF] ${label} is not a regular file.`);
  }
  if (kind.kind === "too_large") {
    throw new Error(
      `[E_FILE_TOO_LARGE] ${label} is ${formatSize(kind.size)}, exceeding the ${formatSize(MAX_BYTES)} edit limit. Use write or a non-line-based approach for very large files.`,
    );
  }
}

export function assertLineCount(lineCount: number, label: string): void {
  if (lineCount > MAX_LINES) {
    throw new Error(
      `[E_FILE_TOO_LARGE] ${label} has ${lineCount} lines, exceeding the ${MAX_LINES}-line edit limit.`,
    );
  }
}
