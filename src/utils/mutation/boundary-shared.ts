import { lstat } from 'node:fs/promises';
import path from 'pathe';
import { normalizeAbsolutePath } from '../path';
import type { MutationAuthority } from './boundary-types';

export function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export function getErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String(error.code)
    : undefined;
}

export function isMissingError(error: unknown): boolean {
  return getErrorCode(error) === 'ENOENT';
}

function isRelativeInside(relativePath: string): boolean {
  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

export function isInsideOrEqual(
  parentPath: string,
  childPath: string,
): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || isRelativeInside(relative);
}

export function statsIdentity(stats: Awaited<ReturnType<typeof lstat>>): {
  dev: string;
  ino: string;
} {
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

export async function lstatIfPresent(
  targetPath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (isMissingError(error)) {
      return undefined;
    }

    throw error;
  }
}

export function projectedCanonicalPath(
  authority: MutationAuthority,
  targetPath: string,
): string {
  return normalizeAbsolutePath(
    path.join(
      authority.trustedBaseCanonicalPath,
      path.relative(authority.trustedBaseLogicalPath, targetPath),
    ),
  );
}
