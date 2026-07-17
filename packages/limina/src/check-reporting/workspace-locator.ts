import { normalizeAbsolutePathIdentity } from '#utils/path';
import { existsSync, realpathSync } from 'node:fs';
import path from 'pathe';
import { findNearestPnpmWorkspaceRoot } from '../core/workspace/actions';

export interface CheckIssueWorkspaceLocation {
  configPath?: string;
  rootDir: string;
}

function findExistingPhysicalAncestor(startDir: string): string {
  let currentDir = normalizeAbsolutePathIdentity(path.resolve(startDir));

  while (!existsSync(currentDir)) {
    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return currentDir;
    }

    currentDir = parentDir;
  }

  return normalizeAbsolutePathIdentity(realpathSync.native(currentDir));
}

export function locateCheckIssueWorkspace(
  options: {
    configPath?: string;
    cwd?: string;
  } = {},
): CheckIssueWorkspaceLocation {
  const cwd = normalizeAbsolutePathIdentity(
    path.resolve(options.cwd ?? process.cwd()),
  );
  const configPath = options.configPath
    ? normalizeAbsolutePathIdentity(path.resolve(cwd, options.configPath))
    : undefined;
  const startDir = findExistingPhysicalAncestor(
    configPath ? path.dirname(configPath) : cwd,
  );

  return {
    ...(configPath ? { configPath } : {}),
    rootDir: findNearestPnpmWorkspaceRoot(startDir),
  };
}
