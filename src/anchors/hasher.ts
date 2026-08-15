/** xxHash64 wrapper used for deterministic anchor candidates (spec §51). */

import xxhash from "xxhash-wasm";

export type Hasher = {
  h32(input: string, seed?: number): number;
  h64(input: string, seed?: bigint): bigint;
  h64ToString(input: string, seed?: bigint): string;
};

let hasher: Hasher | null = null;

export function getH(): Hasher {
  if (hasher) return hasher;
  throw new Error("xxhash-wasm hasher not initialized; await initHasher() first.");
}

const hasherP: Promise<Hasher> = xxhash()
  .then((h) => {
    hasher = h as unknown as Hasher;
    return hasher;
  })
  .catch((err: unknown) => {
    console.error("xxhash-wasm initialization failed:", err);
    throw err;
  });

export function initHasher(): Promise<Hasher> {
  return hasherP;
}

export function xxh64(input: string, seed = 0n): bigint {
  return getH().h64(input, seed);
}
