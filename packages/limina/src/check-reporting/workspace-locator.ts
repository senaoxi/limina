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

function resolveWorkspaceCwd(cwd: string | undefined): string {
  return normalizeAbsolutePathIdentity(path.resolve(cwd || process.cwd()));
}

function resolveWorkspaceConfigPath(
  cwd: string,
  configPath: string | undefined,
): string | undefined {
  if (configPath === undefined) {
    return undefined;
  }

  return normalizeAbsolutePathIdentity(path.resolve(cwd, configPath));
}

function getWorkspaceStartPath(
  cwd: string,
  configPath: string | undefined,
): string {
  return configPath === undefined ? cwd : path.dirname(configPath);
}

function createWorkspaceLocation(
  rootDir: string,
  configPath: string | undefined,
): CheckIssueWorkspaceLocation {
  return configPath === undefined ? { rootDir } : { configPath, rootDir };
}

export function locateCheckIssueWorkspace(
  options: {
    configPath?: string;
    cwd?: string;
  } = {},
): CheckIssueWorkspaceLocation {
  const cwd = resolveWorkspaceCwd(options.cwd);
  const configPath = resolveWorkspaceConfigPath(cwd, options.configPath);
  const startPath = getWorkspaceStartPath(cwd, configPath);
  const physicalStartPath = findExistingPhysicalAncestor(startPath);
  const rootDir = findNearestPnpmWorkspaceRoot(physicalStartPath);

  return createWorkspaceLocation(rootDir, configPath);
}
