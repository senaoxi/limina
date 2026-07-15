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

export function isInvalidWorkspacePattern(pattern: string): boolean {
  return (
    pattern.startsWith('!') ||
    path.isAbsolute(pattern) ||
    /^[A-Za-z]:[\\/]/u.test(pattern) ||
    pattern === '..' ||
    pattern.startsWith('../') ||
    pattern.includes('/../') ||
    pattern.endsWith('/..')
  );
}

export function isInvalidConfigRootPattern(pattern: string): boolean {
  return (
    pattern.startsWith('!') ||
    path.isAbsolute(pattern) ||
    /^[A-Za-z]:[\\/]/u.test(pattern)
  );
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

  if (options.pattern === ownerDirectory) {
    return '.';
  }

  if (options.pattern.startsWith(`${ownerDirectory}/`)) {
    return options.pattern.slice(ownerDirectory.length + 1);
  }

  return null;
}
