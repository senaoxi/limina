import type { lstat } from 'node:fs/promises';
import path from 'pathe';
import { normalizeAbsolutePath } from '../path';
import { assertAuthorityIdentityCurrent } from './authority-base';
import {
  isInsideOrEqual,
  lstatIfPresent,
  projectedCanonicalPath,
} from './boundary-shared';
import {
  type MutationAuthority,
  MutationBoundaryError,
} from './boundary-types';

type FileSystemStats = Awaited<ReturnType<typeof lstat>>;

function assertAuthorityTargetContained(
  authority: MutationAuthority,
  targetPath: string,
): void {
  if (!isInsideOrEqual(authority.logicalMutationRoot, targetPath)) {
    throw new MutationBoundaryError(
      `Mutation target escapes its exact authority: ${targetPath}.`,
    );
  }
}

function assertExactFileAuthority(
  authority: MutationAuthority,
  targetPath: string,
): void {
  if (authority.scope !== 'file') {
    return;
  }

  if (targetPath !== authority.logicalMutationRoot) {
    throw new MutationBoundaryError(
      `File mutation authority only permits its exact target: ${targetPath}.`,
    );
  }
}

function getTrustedBaseRelativePath(
  authority: MutationAuthority,
  targetPath: string,
): string {
  if (!isInsideOrEqual(authority.trustedBaseLogicalPath, targetPath)) {
    throw new MutationBoundaryError(
      `Mutation target escapes its trusted base: ${targetPath}.`,
    );
  }

  return path.relative(authority.trustedBaseLogicalPath, targetPath);
}

function assertOrdinaryDirectory(
  targetPath: string,
  stats: FileSystemStats,
): void {
  if (stats.isSymbolicLink()) {
    throw new MutationBoundaryError(
      `Mutation boundary crosses a symbolic link or junction: ${targetPath}.`,
    );
  }

  if (!stats.isDirectory()) {
    throw new MutationBoundaryError(
      `Mutation boundary component is not a directory: ${targetPath}.`,
    );
  }
}

function assertRegularFile(targetPath: string, stats: FileSystemStats): void {
  if (stats.isSymbolicLink()) {
    throw new MutationBoundaryError(
      `Mutation target is a symbolic link or junction: ${targetPath}.`,
    );
  }

  if (!stats.isFile()) {
    throw new MutationBoundaryError(
      `Mutation file target is not a regular file: ${targetPath}.`,
    );
  }
}

function shouldRequireDirectory(options: {
  final: boolean;
  targetKind: 'directory' | 'file';
}): boolean {
  return !options.final || options.targetKind === 'directory';
}

function assertExistingSegment(options: {
  final: boolean;
  path: string;
  stats: FileSystemStats;
  targetKind: 'directory' | 'file';
}): void {
  if (shouldRequireDirectory(options)) {
    assertOrdinaryDirectory(options.path, options.stats);
    return;
  }

  assertRegularFile(options.path, options.stats);
}

async function inspectLogicalSegment(options: {
  cursor: string;
  final: boolean;
  targetKind: 'directory' | 'file';
}): Promise<boolean> {
  const stats = await lstatIfPresent(options.cursor);

  if (stats === undefined) {
    return true;
  }

  assertExistingSegment({
    final: options.final,
    path: options.cursor,
    stats,
    targetKind: options.targetKind,
  });
  return false;
}

function getRelativePathSegments(relativePath: string): string[] {
  return relativePath === '' ? [] : relativePath.split(path.sep);
}

async function assertLogicalSegmentsSafe(options: {
  authority: MutationAuthority;
  relativePath: string;
  targetKind: 'directory' | 'file';
}): Promise<void> {
  const segments = getRelativePathSegments(options.relativePath);
  let cursor = options.authority.trustedBaseLogicalPath;
  let missingAncestor = false;

  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);

    if (!missingAncestor) {
      missingAncestor = await inspectLogicalSegment({
        cursor,
        final: index === segments.length - 1,
        targetKind: options.targetKind,
      });
    }
  }
}

function assertProjectedPathContained(
  authority: MutationAuthority,
  targetPath: string,
  projected: string,
): void {
  if (!isInsideOrEqual(authority.canonicalMutationRoot, projected)) {
    throw new MutationBoundaryError(
      `Mutation target escapes its canonical authority: ${targetPath}.`,
    );
  }
}

function assertProjectedFilePathExact(
  authority: MutationAuthority,
  targetPath: string,
  projected: string,
): void {
  if (authority.scope !== 'file') {
    return;
  }

  if (projected !== authority.canonicalMutationRoot) {
    throw new MutationBoundaryError(
      `Mutation target does not match its canonical file authority: ${targetPath}.`,
    );
  }
}

function assertCanonicalTargetContained(
  authority: MutationAuthority,
  targetPath: string,
): void {
  const projected = projectedCanonicalPath(authority, targetPath);
  assertProjectedPathContained(authority, targetPath, projected);
  assertProjectedFilePathExact(authority, targetPath, projected);
}

export async function assertLogicalChainSafe(options: {
  authority: MutationAuthority;
  targetPath: string;
  targetKind: 'directory' | 'file';
}): Promise<void> {
  await assertAuthorityIdentityCurrent(options.authority);
  const targetPath = normalizeAbsolutePath(options.targetPath);
  assertAuthorityTargetContained(options.authority, targetPath);
  assertExactFileAuthority(options.authority, targetPath);
  const relativePath = getTrustedBaseRelativePath(
    options.authority,
    targetPath,
  );
  await assertLogicalSegmentsSafe({
    authority: options.authority,
    relativePath,
    targetKind: options.targetKind,
  });
  assertCanonicalTargetContained(options.authority, targetPath);
}
