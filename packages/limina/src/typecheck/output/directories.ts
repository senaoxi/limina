import { preflightMutationBoundary } from '#utils/mutation-boundary';
import { lstat, mkdir, rmdir } from 'node:fs/promises';
import path from 'pathe';
import { isMissingError } from './state';
import type {
  OwnedDeclarationDirectory,
  PreparedDeclarationEntry,
} from './types';

function isExistingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!('code' in error)) return false;
  return String(error.code) === 'EEXIST';
}

function assertOrdinaryDirectory(
  stats: Awaited<ReturnType<typeof lstat>>,
  directory: string,
): void {
  if (stats.isSymbolicLink()) {
    throw new Error(
      `Declaration output parent is not an ordinary directory: ${directory}.`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `Declaration output parent is not an ordinary directory: ${directory}.`,
    );
  }
}

async function readExistingDirectory(directory: string): Promise<boolean> {
  try {
    assertOrdinaryDirectory(await lstat(directory), directory);
    return true;
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
}

function createOwnedDirectory(
  directory: string,
  stats: Awaited<ReturnType<typeof lstat>>,
  transactionToken: string,
): OwnedDeclarationDirectory {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    path: directory,
    transactionToken,
  };
}

async function createParentDirectory(options: {
  directory: string;
  prepared: PreparedDeclarationEntry;
  transactionToken: string;
}): Promise<OwnedDeclarationDirectory | undefined> {
  await preflightMutationBoundary([
    {
      authority: options.prepared.authority,
      kind: 'file',
      path: options.prepared.entry.targetPath,
    },
  ]);
  try {
    await mkdir(options.directory);
  } catch (error) {
    if (!isExistingError(error)) throw error;
    assertOrdinaryDirectory(await lstat(options.directory), options.directory);
    return undefined;
  }
  const stats = await lstat(options.directory);
  assertOrdinaryDirectory(stats, options.directory);
  return createOwnedDirectory(
    options.directory,
    stats,
    options.transactionToken,
  );
}

function getParentDirectories(prepared: PreparedDeclarationEntry): string[] {
  const parentPath = path.dirname(prepared.entry.targetPath);
  const basePath = prepared.authority.trustedBaseLogicalPath;
  const relative = path.relative(basePath, parentPath);
  if (relative === '') return [];
  const directories: string[] = [];
  let cursor = basePath;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    directories.push(cursor);
  }
  return directories;
}

async function ensureParentDirectory(options: {
  directory: string;
  prepared: PreparedDeclarationEntry;
  transactionToken: string;
}): Promise<OwnedDeclarationDirectory | undefined> {
  if (await readExistingDirectory(options.directory)) return undefined;
  return createParentDirectory(options);
}

export async function ensureDeclarationParentDirectories(options: {
  prepared: PreparedDeclarationEntry;
  transactionToken: string;
}): Promise<OwnedDeclarationDirectory[]> {
  const owned: OwnedDeclarationDirectory[] = [];
  for (const directory of getParentDirectories(options.prepared)) {
    const created = await ensureParentDirectory({ ...options, directory });
    if (created !== undefined) owned.push(created);
  }
  return owned;
}

async function readOwnedDirectoryStats(
  owned: OwnedDeclarationDirectory,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(owned.path);
  } catch (error) {
    if (!isMissingError(error)) throw error;
    throw new Error(
      `Transaction-created declaration directory disappeared before cleanup: ${owned.path}.`,
    );
  }
}

function hasOwnedDirectoryIdentity(
  owned: OwnedDeclarationDirectory,
  stats: Awaited<ReturnType<typeof lstat>>,
): boolean {
  if (String(stats.dev) !== owned.dev) return false;
  return String(stats.ino) === owned.ino;
}

export async function rollbackOwnedDirectory(
  owned: OwnedDeclarationDirectory,
): Promise<void> {
  const stats = await readOwnedDirectoryStats(owned);
  assertOrdinaryDirectory(stats, owned.path);
  if (!hasOwnedDirectoryIdentity(owned, stats)) {
    throw new Error(
      `Refusing to remove a declaration directory whose transaction identity drifted: ${owned.path}.`,
    );
  }
  await rmdir(owned.path);
}
