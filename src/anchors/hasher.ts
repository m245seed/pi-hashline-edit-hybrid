/** xxHash64 wrapper used for deterministic anchor candidates (spec §51). */

import xxhash from "xxhash-wasm";

export type Hasher = {
  h32(input: string, seed?: number): number;
  h64(input: string, seed?: bigint): bigint;
  h64ToString(input: string, seed?: bigint): string;
};
function fnv1a64(input: string, seed = 0n): bigint {
  let hash = 0xcbf29ce484222325n ^ seed;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    hash ^= BigInt(code & 0xff);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    if (code > 0xff) {
      hash ^= BigInt((code >> 8) & 0xff);
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
  }
  return hash;
}

export const fallbackHasher: Hasher = {
  h32(input: string, seed = 0): number {
    let hash = 0x811c9dc5 ^ seed;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  },
  h64(input: string, seed = 0n): bigint {
    return fnv1a64(input, seed);
  },
  h64ToString(input: string, seed = 0n): string {
    return fnv1a64(input, seed).toString(16);
  },
};

let hasher: Hasher | null = null;

export function getH(): Hasher {
  return hasher ?? fallbackHasher;
}

const hasherP: Promise<Hasher> = xxhash()
  .then((h) => {
    hasher = h as unknown as Hasher;
    return hasher;
  })
  .catch((err: unknown) => {
    console.error("xxhash-wasm initialization failed, using fallback:", err);
    return fallbackHasher;
  });

export function initHasher(): Promise<Hasher> {
  return hasherP;
}

export function xxh64(input: string, seed = 0n): bigint {
  return getH().h64(input, seed);
}
