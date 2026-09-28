import type { WorkspacePackage } from '#core/workspace/actions';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';

function getScopedPackageName(
  parts: string[],
  nodeModulesIndex: number,
): string | null {
  const scope = parts[nodeModulesIndex + 1];
  const name = parts[nodeModulesIndex + 2];

  return scope && name ? `${scope}/${name}` : null;
}

function resolveNodeModulesPackageName(options: {
  nodeModulesIndex: number;
  packageName: string;
  parts: string[];
}): string | null {
  if (options.packageName.startsWith('@')) {
    return getScopedPackageName(options.parts, options.nodeModulesIndex);
  }

  return options.packageName;
}

export function getNodeModulesPackageName(filePath: string): string | null {
  const parts = filePath.split('/');
  const nodeModulesIndex = parts.lastIndexOf('node_modules');

  if (nodeModulesIndex === -1) {
    return null;
  }

  const packageName = parts[nodeModulesIndex + 1];
  if (!packageName) {
    return null;
  }

  return resolveNodeModulesPackageName({
    nodeModulesIndex,
    packageName,
    parts,
  });
}

function getWorkspacePackageName(
  filePath: string,
  workspaceLookup: WorkspaceLookupIndex,
): string | null {
  const workspacePackage = workspaceLookup.findPackageForFile(filePath);
  if (!workspacePackage) {
    return null;
  }

  return workspacePackage.name ?? null;
}

export function getResolvedPackageName(
  filePath: string,
  workspaceLookup: WorkspaceLookupIndex,
): string | null {
  const nodeModulesPackageName = getNodeModulesPackageName(filePath);
  if (nodeModulesPackageName) {
    return nodeModulesPackageName;
  }

  return getWorkspacePackageName(filePath, workspaceLookup);
}

export function getResolvedWorkspacePackage(
  filePath: string,
  workspaceLookup: WorkspaceLookupIndex,
): WorkspacePackage | null {
  if (getNodeModulesPackageName(filePath)) {
    return null;
  }

  return workspaceLookup.findPackageForFile(filePath);
}
