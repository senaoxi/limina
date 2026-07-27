import path from 'pathe';

import type { ResolvedLiminaConfig } from '#config/runner';
import type { PackageOwner } from '#core/workspace/actions';
import { normalizeSlashes, toRelativePath } from '#utils/path';

export function normalizeWorkspacePattern(value: string): string {
  let pattern = normalizeSlashes(value.trim());

  while (pattern.startsWith('./')) {
    pattern = pattern.slice(2);
  }

  return pattern;
}

export function isInvalidConfigRootPattern(pattern: string): boolean {
  return (
    pattern.startsWith('!') ||
    path.isAbsolute(pattern) ||
    /^[A-Za-z]:[\\/]/u.test(pattern)
  );
}

function isOwnerRootPattern(pattern: string, ownerDirectory: string): boolean {
  return pattern === ownerDirectory;
}

function isOwnerNestedPattern(
  pattern: string,
  ownerDirectory: string,
): boolean {
  return pattern.startsWith(`${ownerDirectory}/`);
}

function resolveOwnerNestedPattern(
  pattern: string,
  ownerDirectory: string,
): string | null {
  return isOwnerNestedPattern(pattern, ownerDirectory)
    ? pattern.slice(ownerDirectory.length + 1)
    : null;
}

export function toOwnerRelativeEntryPattern(options: {
  config: ResolvedLiminaConfig;
  owner: PackageOwner;
  pattern: string;
}): string | null {
  const ownerDirectory = toRelativePath(
    options.config.rootDir,
    options.owner.directory,
  );

  if (ownerDirectory === '.') {
    return options.pattern;
  }

  if (isOwnerRootPattern(options.pattern, ownerDirectory)) {
    return '.';
  }

  return resolveOwnerNestedPattern(options.pattern, ownerDirectory);
}
