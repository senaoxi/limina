import { normalizeAbsolutePath } from '#utils/path';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import path from 'pathe';
import { createDescriptorCandidate, isMissingFsError } from '../shared';
import { isAddPackageDescriptor, isAddWorkspaceDescriptor } from './boundaries';
import type {
  DirectoryEntries,
  DirectoryEntryStats,
  IslandWalkContext,
} from './types';

function hasChildPackageRoot(options: {
  childRoots: readonly string[];
  directory: string;
}): boolean {
  const directory = normalizeAbsolutePath(options.directory);
  return options.childRoots.some(
    (childRoot) => normalizeAbsolutePath(childRoot) === directory,
  );
}

async function isCrossesChildPackageBoundary(
  context: IslandWalkContext,
  directory: string,
): Promise<boolean> {
  return (
    hasChildPackageRoot({ childRoots: context.childRoots, directory }) ||
    context.canonicalChildRoots.has(
      normalizeAbsolutePath(await realpath(directory)),
    )
  );
}

async function openDirectoryOrNull(directory: string) {
  try {
    return await opendir(directory);
  } catch (error) {
    if (isMissingFsError(error)) return null;
    throw error;
  }
}

const tsconfigNamePattern = /^tsconfig(?:\.[^.]+)*\.json$/u;

function isBoundaryDescriptorName(name: string): boolean {
  return name === 'package.json' || name === 'pnpm-workspace.yaml';
}

async function addDirectoryEntry(
  names: DirectoryEntries,
  directory: string,
  entry: { isSymbolicLink(): boolean; name: string },
): Promise<void> {
  const entryPath = path.join(directory, entry.name);
  if (entry.isSymbolicLink()) {
    if (!isBoundaryDescriptorName(entry.name)) return;
    names.set(entry.name, await readDescriptorTarget(entryPath));
    return;
  }
  names.set(entry.name, await lstat(entryPath));
}

async function readDescriptorTarget(
  entryPath: string,
): Promise<DirectoryEntryStats> {
  const target = await stat(entryPath);
  if (!target.isFile()) {
    throw new Error(`Workspace descriptor is not a regular file: ${entryPath}`);
  }
  return target;
}

async function readDirectoryEntries(
  directory: string,
): Promise<DirectoryEntries | null> {
  const entries = await openDirectoryOrNull(directory);
  if (entries === null) return null;
  const names: DirectoryEntries = new Map();
  for await (const entry of entries) {
    await addDirectoryEntry(names, directory, entry);
  }
  return names;
}

function isTsconfigEntry(name: string, stats: DirectoryEntryStats): boolean {
  return stats.isFile() && tsconfigNamePattern.test(name);
}

async function addTsconfigDescriptors(options: {
  context: IslandWalkContext;
  directory: string;
  names: ReadonlyMap<string, DirectoryEntryStats>;
}): Promise<void> {
  const configNames = [...options.names]
    .filter(([name, stats]) => isTsconfigEntry(name, stats))
    .map(([name]) => name);
  const descriptors = await Promise.all(
    configNames.map((name) =>
      createDescriptorCandidate({
        config: options.context.config,
        kind: 'tsconfig',
        ownerDirectory: options.context.ownerRootDir,
        path: path.join(options.directory, name),
        rootDir: options.directory,
      }),
    ),
  );
  options.context.result.descriptors.push(...descriptors);
}

function isWalkableDirectory(
  name: string,
  stats: DirectoryEntryStats,
): boolean {
  return (
    stats.isDirectory() &&
    !new Set(['.git', '.limina', 'node_modules']).has(name)
  );
}

async function walkChildren(options: {
  context: IslandWalkContext;
  directory: string;
  names: ReadonlyMap<string, DirectoryEntryStats>;
}): Promise<void> {
  const childNames = [...options.names]
    .filter(([name, stats]) => isWalkableDirectory(name, stats))
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
  for (const name of childNames) {
    await walkPackageIsland(
      options.context,
      path.join(options.directory, name),
      false,
    );
  }
}

async function isProcessDirectoryDescriptors(options: {
  context: IslandWalkContext;
  directory: string;
  isOwnerRoot: boolean;
  names: DirectoryEntries;
}): Promise<boolean> {
  const isWorkspaceBoundary = await isAddWorkspaceDescriptor(options);
  return isWorkspaceBoundary || isAddPackageDescriptor(options);
}

async function isBlockedChildDirectory(options: {
  context: IslandWalkContext;
  directory: string;
  isOwnerRoot: boolean;
}): Promise<boolean> {
  return (
    !options.isOwnerRoot &&
    isCrossesChildPackageBoundary(options.context, options.directory)
  );
}

async function prepareDirectoryWalk(options: {
  context: IslandWalkContext;
  directory: string;
  isOwnerRoot: boolean;
}): Promise<DirectoryEntries | null> {
  const isBlocked = await isBlockedChildDirectory(options);
  return isBlocked ? null : readDirectoryEntries(options.directory);
}

async function processDirectoryWalk(options: {
  context: IslandWalkContext;
  directory: string;
  isOwnerRoot: boolean;
  names: DirectoryEntries;
}): Promise<void> {
  const isBoundary = await isProcessDirectoryDescriptors(options);
  if (isBoundary) return;
  await addTsconfigDescriptors(options);
  await walkChildren(options);
}

export async function walkPackageIsland(
  context: IslandWalkContext,
  directory: string,
  isOwnerRoot: boolean,
): Promise<void> {
  const names = await prepareDirectoryWalk({ context, directory, isOwnerRoot });
  if (names === null) return;
  await processDirectoryWalk({ context, directory, isOwnerRoot, names });
}
