/**
 * Symlink-aware target resolution (spec §43).
 *
 * Mutations follow symlinks rather than replacing the symlink itself, so
 * editing `src/config.ts` changes the real target while preserving the
 * symbolic link. Symlink loops are detected and reported as ELOOP.
 * Note: visitedSymlinks tracks visited paths (matching Node realpath semantics)
 * rather than (device, inode) pairs.
 */

import { lstat, readlink } from "fs/promises";
import { dirname, join, parse, resolve, sep } from "path";
import { errCode } from "../utils";

export async function resolveTarget(path: string): Promise<string> {
  const absolutePath = resolve(path);
  const { root } = parse(absolutePath);
  const parts = absolutePath
    .slice(root.length)
    .split(sep)
    .filter((part) => part.length > 0);
  const visitedSymlinks = new Set<string>();

  async function resParts(
    currentPath: string,
    remainingParts: string[],
  ): Promise<string> {
    if (remainingParts.length === 0) {
      return currentPath;
    }
    const [nextPart, ...tail] = remainingParts;
    const candidatePath = join(currentPath, nextPart!);
    try {
      const candidateStats = await lstat(candidatePath);
      if (!candidateStats.isSymbolicLink()) {
        return resParts(candidatePath, tail);
      }
      if (visitedSymlinks.has(candidatePath)) {
        const error = new Error(
          `Too many symbolic links while resolving ${path}`,
        ) as NodeJS.ErrnoException;
        error.code = "ELOOP";
        throw error;
      }
      visitedSymlinks.add(candidatePath);
      const linkTargetPath = resolve(
        dirname(candidatePath),
        await readlink(candidatePath),
      );
      const targetParts = linkTargetPath
        .slice(parse(linkTargetPath).root.length)
        .split(sep)
        .filter((part) => part.length > 0);
      return resParts(parse(linkTargetPath).root, [
        ...targetParts,
        ...tail,
      ]);
    } catch (error: unknown) {
      if (errCode(error) === "ENOENT") {
        return join(candidatePath, ...tail);
      }
      throw error;
    }
  }
  return resParts(root, parts);
}
