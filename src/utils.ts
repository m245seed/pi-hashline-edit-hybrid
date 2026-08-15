import { createHash } from "crypto";

export function isRec(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rejectUnknownFields(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `[E_BAD_SHAPE] ${label} contains unknown or unsupported fields: ${unknown.join(", ")}.`,
    );
  }
}

export function abortIf(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}

export function errCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return undefined;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
