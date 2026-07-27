import type { PackageManifest } from '#core/workspace/actions';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type { NearestPackageInfo } from '../../packages/owners';
import type { WorkspaceIndexMetricsRecorder } from '../validated-context';

export function createDirectoryMap<T extends { directory: string }>(
  items: readonly T[],
): Map<string, T> {
  const byDirectory = new Map<string, T>();

  for (const item of items) {
    const directory = normalizeAbsolutePath(item.directory);
    if (!byDirectory.has(directory)) {
      byDirectory.set(directory, item);
    }
  }

  return byDirectory;
}

export function getAncestorDirectories(filePath: string): string[] {
  const directories: string[] = [];
  let current = normalizeAbsolutePath(filePath);

  while (true) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
}

function getDirectoryLookupStart<T>(
  filePath: string,
  itemsByDirectory: ReadonlyMap<string, T>,
): string {
  const normalizedPath = normalizeAbsolutePath(filePath);
  return itemsByDirectory.has(normalizedPath)
    ? normalizedPath
    : normalizeAbsolutePath(path.dirname(normalizedPath));
}

export function findNearestDirectoryItem<T>(
  filePath: string,
  itemsByDirectory: ReadonlyMap<string, T>,
): T | null {
  const startDirectory = getDirectoryLookupStart(filePath, itemsByDirectory);

  for (const directory of getAncestorDirectories(startDirectory)) {
    const item = itemsByDirectory.get(directory);
    if (item !== undefined) {
      return item;
    }
  }

  return null;
}

export function getManifestPackageName(
  manifest: PackageManifest,
): string | undefined {
  if (typeof manifest.name !== 'string') {
    return undefined;
  }

  const name = manifest.name.trim();
  return name.length > 0 ? name : undefined;
}

export function isNodeModulesPath(filePath: string): boolean {
  return normalizeAbsolutePath(filePath).split('/').includes('node_modules');
}

export function isNodeModulesPackageRoot(directory: string): boolean {
  const parentDirectory = path.dirname(directory);
  const parentName = path.basename(parentDirectory);

  if (parentName === 'node_modules') {
    return true;
  }

  return (
    parentName.startsWith('@') &&
    path.basename(path.dirname(parentDirectory)) === 'node_modules'
  );
}

export function isPackageInfoInsideNodeModules(
  packageInfo: NearestPackageInfo,
): boolean {
  return isNodeModulesPath(packageInfo.directory);
}

export function setCachedPackageInfo(
  cache: Map<string, NearestPackageInfo | null>,
  directories: readonly string[],
  packageInfo: NearestPackageInfo | null,
): void {
  for (const directory of directories) {
    cache.set(directory, packageInfo);
  }
}

export function recordLookupMetric(options: {
  kind: string;
  metrics: WorkspaceIndexMetricsRecorder | undefined;
  state: 'hit' | 'miss';
  value: unknown;
}): void {
  options.metrics?.record({
    kind: options.kind,
    name:
      options.state === 'hit' ? 'provider-cache-hit' : 'provider-cache-miss',
    provider: 'workspace-lookup-index',
  });
  recordNegativeLookup(options);
}

function recordNegativeLookup(options: {
  kind: string;
  metrics: WorkspaceIndexMetricsRecorder | undefined;
  value: unknown;
}): void {
  if (options.value !== null) {
    return;
  }

  options.metrics?.record({
    kind: options.kind,
    name: 'workspace-negative-lookup',
    provider: 'workspace-lookup-index',
  });
}
