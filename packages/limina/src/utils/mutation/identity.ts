import { createHash } from 'node:crypto';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'pathe';
import {
  lstatIfPresent,
  projectedCanonicalPath,
  stableJson,
  statsIdentity,
} from './boundary-shared';
import {
  type MutationAuthority,
  MutationBoundaryError,
  type MutationNodeIdentity,
  type RegularFileMutationIdentity,
} from './boundary-types';

type FileSystemStats = Awaited<ReturnType<typeof lstat>>;
type FileHandle = Awaited<ReturnType<typeof open>>;

function isOrdinaryFileStats(stats: FileSystemStats): boolean {
  return !stats.isSymbolicLink() && stats.isFile();
}

function assertOrdinaryFileStats(
  targetPath: string,
  stats: FileSystemStats,
): void {
  if (!isOrdinaryFileStats(stats)) {
    throw new MutationBoundaryError(
      `Mutation file target is not an ordinary regular file: ${targetPath}.`,
    );
  }
}

function identitiesMatch(options: {
  after: FileSystemStats;
  before: FileSystemStats;
  expected: FileSystemStats;
}): boolean {
  return (
    stableJson(statsIdentity(options.expected)) ===
      stableJson(statsIdentity(options.before)) &&
    stableJson(statsIdentity(options.before)) ===
      stableJson(statsIdentity(options.after))
  );
}

function fileMetadataMatches(
  before: FileSystemStats,
  after: FileSystemStats,
): boolean {
  return before.nlink === after.nlink && before.size === after.size;
}

function assertStableFileIdentity(options: {
  after: FileSystemStats;
  before: FileSystemStats;
  expected: FileSystemStats;
  targetPath: string;
}): void {
  if (
    !identitiesMatch(options) ||
    !fileMetadataMatches(options.before, options.after)
  ) {
    throw new MutationBoundaryError(
      `Regular file identity drifted while it was inspected: ${options.targetPath}.`,
    );
  }
}

async function readStableFile(options: {
  handle: FileHandle;
  pathStats: FileSystemStats;
  targetPath: string;
}): Promise<{ before: FileSystemStats; content: Buffer }> {
  const before = await options.handle.stat();
  const content = await options.handle.readFile();
  const after = await options.handle.stat();
  assertStableFileIdentity({
    after,
    before,
    expected: options.pathStats,
    targetPath: options.targetPath,
  });
  return { before, content };
}

export async function captureRegularFileIdentity(
  targetPath: string,
): Promise<RegularFileMutationIdentity> {
  const pathStats = await lstat(targetPath);
  assertOrdinaryFileStats(targetPath, pathStats);
  const handle = await open(targetPath, 'r');

  try {
    const { before, content } = await readStableFile({
      handle,
      pathStats,
      targetPath,
    });
    return {
      ...statsIdentity(before),
      hash: createHash('sha256').update(content).digest('hex'),
      kind: 'file',
      length: content.byteLength,
      mode: Number(before.mode) & 0o7777,
      nlink: Number(before.nlink),
    };
  } finally {
    await handle.close();
  }
}

function createMissingIdentity(options: {
  authority: MutationAuthority;
  path: string;
}): MutationNodeIdentity {
  return {
    canonicalProjection: projectedCanonicalPath(
      options.authority,
      options.path,
    ),
    kind: 'missing',
    path: options.path,
  };
}

function createDirectoryIdentity(options: {
  authority: MutationAuthority;
  path: string;
  stats: FileSystemStats;
}): MutationNodeIdentity {
  return {
    ...statsIdentity(options.stats),
    canonicalPath: projectedCanonicalPath(options.authority, options.path),
    diagnosticNlink: Number(options.stats.nlink),
    kind: 'directory',
  };
}

function assertNotSymbolicLink(
  pathValue: string,
  stats: FileSystemStats,
): void {
  if (stats.isSymbolicLink()) {
    throw new MutationBoundaryError(
      `Mutation boundary contains a symbolic link or junction: ${pathValue}.`,
    );
  }
}

async function captureExistingNodeIdentity(options: {
  authority: MutationAuthority;
  path: string;
  stats: FileSystemStats;
}): Promise<MutationNodeIdentity> {
  assertNotSymbolicLink(options.path, options.stats);

  if (options.stats.isDirectory()) {
    return createDirectoryIdentity(options);
  }

  if (options.stats.isFile()) {
    return captureRegularFileIdentity(options.path);
  }

  throw new MutationBoundaryError(
    `Mutation boundary contains an unsupported filesystem node: ${options.path}.`,
  );
}

export async function captureNodeIdentity(options: {
  authority: MutationAuthority;
  path: string;
}): Promise<MutationNodeIdentity> {
  const stats = await lstatIfPresent(options.path);
  return stats === undefined
    ? createMissingIdentity(options)
    : captureExistingNodeIdentity({ ...options, stats });
}

async function visitDirectoryEntry(options: {
  authority: MutationAuthority;
  entries: Map<string, MutationNodeIdentity>;
  entryPath: string;
}): Promise<void> {
  const identity = await captureNodeIdentity({
    authority: options.authority,
    path: options.entryPath,
  });
  options.entries.set(options.entryPath, identity);

  if (identity.kind === 'directory') {
    await walkDirectorySubtree({
      authority: options.authority,
      entries: options.entries,
      rootPath: options.entryPath,
    });
  }
}

export async function walkDirectorySubtree(options: {
  authority: MutationAuthority;
  entries: Map<string, MutationNodeIdentity>;
  rootPath: string;
}): Promise<void> {
  const directory = await opendir(options.rootPath);

  for await (const entry of directory) {
    await visitDirectoryEntry({
      authority: options.authority,
      entries: options.entries,
      entryPath: path.join(options.rootPath, entry.name),
    });
  }
}
