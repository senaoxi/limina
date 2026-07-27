import { normalizeAbsolutePath } from '#utils/path';
import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'pathe';
import { createDescriptorCandidate, isMissingFsError } from '../shared';
import { addPackageDescriptor, addWorkspaceDescriptor } from './boundaries';
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

async function crossesChildPackageBoundary(
  context: IslandWalkContext,
  directory: string,
): Promise<boolean> {
  if (hasChildPackageRoot({ childRoots: context.childRoots, directory })) {
    return true;
  }
  return context.canonicalChildRoots.has(
    normalizeAbsolutePath(await realpath(directory)),
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

async function addDirectoryEntry(
  names: DirectoryEntries,
  directory: string,
  entry: { isSymbolicLink(): boolean; name: string },
): Promise<void> {
  if (entry.isSymbolicLink()) return;
  names.set(entry.name, await lstat(path.join(directory, entry.name)));
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
  if (!stats.isFile()) return false;
  return /^tsconfig(?:\.[^.]+)*\.json$/u.test(name);
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
  if (!stats.isDirectory()) return false;
  return !new Set(['.git', '.limina', 'node_modules']).has(name);
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

async function processDirectoryDescriptors(options: {
  context: IslandWalkContext;
  directory: string;
  isOwnerRoot: boolean;
  names: DirectoryEntries;
}): Promise<boolean> {
  const workspaceBoundary = await addWorkspaceDescriptor(options);
  if (workspaceBoundary) return true;
  return addPackageDescriptor(options);
}

async function isBlockedChildDirectory(options: {
  context: IslandWalkContext;
  directory: string;
  isOwnerRoot: boolean;
}): Promise<boolean> {
  if (options.isOwnerRoot) return false;
  return crossesChildPackageBoundary(options.context, options.directory);
}

async function prepareDirectoryWalk(options: {
  context: IslandWalkContext;
  directory: string;
  isOwnerRoot: boolean;
}): Promise<DirectoryEntries | null> {
  const blocked = await isBlockedChildDirectory(options);
  if (blocked) return null;
  return readDirectoryEntries(options.directory);
}

async function processDirectoryWalk(options: {
  context: IslandWalkContext;
  directory: string;
  isOwnerRoot: boolean;
  names: DirectoryEntries;
}): Promise<void> {
  const boundary = await processDirectoryDescriptors(options);
  if (boundary) return;
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
