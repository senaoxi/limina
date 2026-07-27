import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'pathe';
import {
  ArtifactNamespaceContainmentError,
  assertArtifactPathLexicallyContained,
  isArtifactPathInsideOrEqual,
  type LiminaArtifactNamespace,
  normalizeArtifactAbsolutePath,
} from './namespace-core';

export type ArtifactPathSafetyRole =
  | 'parent-directory'
  | 'target-directory'
  | 'target-file';
export type ArtifactTargetKind = 'directory' | 'file';

interface StatsSafetyValidator {
  applies(roles: ReadonlySet<ArtifactPathSafetyRole>): boolean;
  message(targetPath: string): string;
  valid(stats: Stats): boolean;
}

const statsSafetyValidators: readonly StatsSafetyValidator[] = [
  {
    applies: () => true,
    message: (targetPath) =>
      `Generated-artifact mutation crosses a symbolic link: ${targetPath}.`,
    valid: (stats) => !stats.isSymbolicLink(),
  },
  {
    applies: (roles) => roles.has('parent-directory'),
    message: (targetPath) =>
      `Generated-artifact parent is not a directory: ${targetPath}.`,
    valid: (stats) => stats.isDirectory(),
  },
  {
    applies: (roles) => roles.has('target-file'),
    message: (targetPath) =>
      `Generated-artifact target is not a regular file: ${targetPath}.`,
    valid: (stats) => stats.isFile(),
  },
  {
    applies: (roles) => roles.has('target-directory'),
    message: (targetPath) =>
      `Generated-artifact target is not a directory: ${targetPath}.`,
    valid: (stats) => stats.isDirectory(),
  },
];

function getErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String(error.code)
    : undefined;
}

export async function lstatIfPresent(
  targetPath: string,
): Promise<Stats | undefined> {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

function validatorFails(options: {
  roles: ReadonlySet<ArtifactPathSafetyRole>;
  stats: Stats;
  validator: StatsSafetyValidator;
}): boolean {
  return (
    options.validator.applies(options.roles) &&
    !options.validator.valid(options.stats)
  );
}

export function assertArtifactPathStatsSafe(
  targetPath: string,
  stats: Stats,
  roles: ReadonlySet<ArtifactPathSafetyRole>,
): void {
  const invalid = statsSafetyValidators.find((validator) =>
    validatorFails({ roles, stats, validator }),
  );

  if (invalid !== undefined) {
    throw new ArtifactNamespaceContainmentError(invalid.message(targetPath));
  }
}

export function assertProjectedCanonicalContainment(
  namespace: LiminaArtifactNamespace,
  targetPath: string,
): string {
  assertArtifactPathLexicallyContained(namespace, targetPath);
  const normalizedTarget = normalizeArtifactAbsolutePath(targetPath);
  const projectedCanonicalTarget = path.join(
    namespace.canonicalRootDir,
    path.relative(namespace.rootDir, normalizedTarget),
  );
  const canonicalTarget = normalizeArtifactAbsolutePath(
    projectedCanonicalTarget,
  );

  if (
    !isArtifactPathInsideOrEqual(namespace.canonicalRootDir, canonicalTarget)
  ) {
    throw new ArtifactNamespaceContainmentError(
      `Generated-artifact path escapes the canonical namespace: ${targetPath}.`,
    );
  }

  return normalizedTarget;
}

export function getRelativeSegments(
  namespace: LiminaArtifactNamespace,
  targetPath: string,
): string[] {
  const relative = path.relative(namespace.rootDir, targetPath);
  return relative === '' ? [] : relative.split(path.sep);
}
