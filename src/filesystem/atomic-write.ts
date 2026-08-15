/**
 * Atomic write (spec §29, §44–§46).
 *
 * Normal files are replaced via `.tmp-<uuid>` + fsync + rename + parent-dir
 * fsync. Hard-linked files (nlink > 1) are written in place to preserve the
 * shared inode, with a `W_HARDLINK_NONATOMIC` warning — the write still
 * rechecks the checksum beforehand and fsyncs after (spec §44). Mode bits
 * are preserved across the atomic rename (spec §46); ACLs, xattrs, and
 * ownership are not promised. There is no silent non-atomic fallback:
 * a failed atomic replacement reports E_ATOMIC_REPLACE_FAILED (spec §45).
 */

import { randomUUID } from "crypto";
import {
  open,
  readdir,
  rename,
  rm,
  stat,
  type FileHandle,
} from "fs/promises";
import { dirname, join } from "path";
import { STALE_TEMP_MS } from "../constants";
import { errCode } from "../utils";
import { resolveTarget } from "./resolve-target";

const TEMP_PREFIX = ".tmp-";
const TEMP_UUID_RE =
  /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sweptDirs = new Set<string>();

async function sweepStaleTemps(dir: string): Promise<void> {
  if (sweptDirs.has(dir)) return;
  sweptDirs.add(dir);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile() || !TEMP_UUID_RE.test(entry.name)) continue;
      const tempPath = join(dir, entry.name);
      try {
        const stats = await stat(tempPath);
        if (now - stats.mtimeMs > STALE_TEMP_MS) {
          await rm(tempPath, { force: true });
        }
      } catch {}
    }
  } catch {}
}

export async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {}
}

export interface TargetInfo {
  targetPath: string;
  mode?: number;
  hardlink: boolean;
}

/** Resolve the real target and inspect it for the commit protocol. */
export async function inspectTarget(path: string): Promise<TargetInfo> {
  const targetPath = await resolveTarget(path);
  try {
    const info = await stat(targetPath);
    return {
      targetPath,
      mode: info.mode & 0o7777,
      hardlink: info.nlink > 1,
    };
  } catch (error: unknown) {
    if (errCode(error) === "ENOENT") {
      return { targetPath, hardlink: false };
    }
    throw error;
  }
}

/**
 * Phase 4 — prepare temp file: same directory, exclusive create, write,
 * apply mode, fsync.
 */
export async function prepareTempWrite(
  targetPath: string,
  content: string,
  mode?: number,
): Promise<string> {
  const dir = dirname(targetPath);
  await sweepStaleTemps(dir);
  const tempPath = join(dir, `${TEMP_PREFIX}${randomUUID()}`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf-8");
    if (mode !== undefined) {
      await handle.chmod(mode);
    }
    await handle.sync();
  } catch (error: unknown) {
    await handle.close();
    try {
      await rm(tempPath, { force: true });
    } catch {}
    throw error;
  }
  await handle.close();
  return tempPath;
}

/** Phase 6 — commit: rename temp over target, then fsync the parent dir. */
export async function commitTempFile(
  tempPath: string,
  targetPath: string,
): Promise<void> {
  const dir = dirname(targetPath);
  await rename(tempPath, targetPath);
  await syncDir(dir);
}

export async function removeTempFile(tempPath: string): Promise<void> {
  try {
    await rm(tempPath, { force: true });
  } catch {}
}

/** Phase 5 — precommit verification (spec §29, §33). */
export async function precommitVerify(
  path: string,
  originalTarget: string,
  rawBefore: Buffer,
): Promise<void> {
  const currentTarget = await resolveTarget(path);
  if (currentTarget !== originalTarget) {
    throw new Error(
      `[E_PATH_CHANGED] The target of ${path} changed during transaction preparation (it now resolves to ${currentTarget}). Nothing was modified.`,
    );
  }
  const handle = await open(currentTarget, "r");
  let current: Buffer;
  try {
    const info = await handle.stat();
    current = Buffer.alloc(info.size);
    if (info.size > 0) {
      await handle.read(current, 0, info.size, 0);
    }
  } finally {
    await handle.close();
  }
  if (!current.equals(rawBefore)) {
    throw new Error(
      `[E_COMMIT_STALE] The file changed on disk during transaction preparation. Nothing was modified.`,
    );
  }
}

/**
 * Hard-link in-place write (spec §44): recheck checksum before writing,
 * write through one open handle, fsync after.
 */
export async function writeInPlace(
  targetPath: string,
  content: string,
  mode?: number,
): Promise<void> {
  const handle = await open(targetPath, "w");
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    if (mode !== undefined) {
      await handle.chmod(mode);
    }
  } finally {
    await handle.close();
  }
}
