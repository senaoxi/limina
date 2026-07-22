import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  open,
  opendir,
  readlink,
  realpath,
  stat,
} from 'node:fs/promises';
import path from 'pathe';

import { normalizeAbsolutePath } from './path';

const authorityBrand: unique symbol = Symbol('MutationAuthority');
const authenticatedAuthorities = new WeakSet<object>();

export type MutationAuthorityScope = 'directory' | 'file';

interface FileSystemIdentityBase {
  readonly dev: string;
  readonly ino: string;
  readonly kind: 'directory' | 'file';
}

export interface DirectoryMutationIdentity extends FileSystemIdentityBase {
  readonly canonicalPath: string;
  readonly diagnosticNlink: number;
  readonly kind: 'directory';
}

export interface RegularFileMutationIdentity extends FileSystemIdentityBase {
  readonly hash: string;
  readonly kind: 'file';
  readonly length: number;
  readonly mode: number;
  readonly nlink: number;
}

interface TrustedBaseIdentity {
  readonly canonicalPath: string;
  readonly canonicalTarget: {
    readonly dev: string;
    readonly ino: string;
    readonly kind: 'directory';
  };
  readonly logicalEntry: {
    readonly dev: string;
    readonly ino: string;
    readonly kind: 'directory' | 'symlink';
    readonly linkTarget?: string;
  };
}

export interface MutationAuthority {
  readonly [authorityBrand]: true;
  readonly canonicalMutationRoot: string;
  readonly generation: string;
  readonly logicalMutationRoot: string;
  readonly scope: MutationAuthorityScope;
  readonly trustedBaseCanonicalPath: string;
  readonly trustedBaseIdentity: TrustedBaseIdentity;
  readonly trustedBaseLogicalPath: string;
}

export interface MutationBoundaryTarget {
  readonly authority: MutationAuthority;
  readonly kind: 'directory' | 'file';
  readonly path: string;
  readonly recursive?: boolean;
}

interface MissingMutationIdentity {
  readonly canonicalProjection: string;
  readonly kind: 'missing';
  readonly path: string;
}

type MutationNodeIdentity =
  | DirectoryMutationIdentity
  | MissingMutationIdentity
  | RegularFileMutationIdentity;

interface MutationBoundarySnapshotEntry {
  readonly identity: MutationNodeIdentity;
  readonly path: string;
}

export interface MutationBoundarySnapshot {
  readonly authorityFingerprints: readonly string[];
  readonly entries: readonly MutationBoundarySnapshotEntry[];
  readonly fingerprint: string;
  readonly targets: readonly MutationBoundaryTarget[];
}

export class MutationBoundaryError extends Error {
  override readonly name = 'MutationBoundaryError';
}

function isMissingError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && String(error.code) === 'ENOENT'
  );
}

function isInsideOrEqual(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function statsIdentity(stats: Awaited<ReturnType<typeof lstat>>): {
  dev: string;
  ino: string;
} {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
  };
}

async function lstatIfPresent(
  targetPath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw error;
  }
}

function assertOrdinaryDirectory(
  targetPath: string,
  stats: Awaited<ReturnType<typeof lstat>>,
): void {
  if (stats.isSymbolicLink()) {
    throw new MutationBoundaryError(
      `Mutation boundary crosses a symbolic link or junction: ${targetPath}.`,
    );
  }
  if (!stats.isDirectory()) {
    throw new MutationBoundaryError(
      `Mutation boundary component is not a directory: ${targetPath}.`,
    );
  }
}

async function captureTrustedBaseIdentity(
  trustedBasePath: string,
): Promise<TrustedBaseIdentity> {
  const logicalPath = normalizeAbsolutePath(trustedBasePath);
  const logicalStats = await lstat(logicalPath);
  const logicalIdentity = statsIdentity(logicalStats);
  const isAlias = logicalStats.isSymbolicLink();

  if (!isAlias && !logicalStats.isDirectory()) {
    throw new MutationBoundaryError(
      `Trusted mutation base is not a directory: ${logicalPath}.`,
    );
  }

  const canonicalPath = normalizeAbsolutePath(await realpath(logicalPath));
  const canonicalStats = await stat(canonicalPath);
  if (!canonicalStats.isDirectory()) {
    throw new MutationBoundaryError(
      `Trusted mutation base does not resolve to a directory: ${logicalPath}.`,
    );
  }

  return {
    canonicalPath,
    canonicalTarget: {
      ...statsIdentity(canonicalStats),
      kind: 'directory',
    },
    logicalEntry: {
      ...logicalIdentity,
      kind: isAlias ? 'symlink' : 'directory',
      ...(isAlias ? { linkTarget: await readlink(logicalPath) } : {}),
    },
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function authorityFingerprint(authority: MutationAuthority): string {
  return stableJson({
    canonicalMutationRoot: authority.canonicalMutationRoot,
    generation: authority.generation,
    logicalMutationRoot: authority.logicalMutationRoot,
    scope: authority.scope,
    trustedBaseCanonicalPath: authority.trustedBaseCanonicalPath,
    trustedBaseIdentity: authority.trustedBaseIdentity,
    trustedBaseLogicalPath: authority.trustedBaseLogicalPath,
  });
}

export function assertMutationAuthority(authority: MutationAuthority): void {
  if (!authenticatedAuthorities.has(authority)) {
    throw new MutationBoundaryError(
      'Unauthenticated filesystem mutation authority.',
    );
  }
}

async function assertAuthorityIdentityCurrent(
  authority: MutationAuthority,
): Promise<void> {
  assertMutationAuthority(authority);
  const current = await captureTrustedBaseIdentity(
    authority.trustedBaseLogicalPath,
  );
  if (stableJson(current) !== stableJson(authority.trustedBaseIdentity)) {
    throw new MutationBoundaryError(
      `Trusted mutation base identity drifted: ${authority.trustedBaseLogicalPath}.`,
    );
  }
}

function projectedCanonicalPath(
  authority: MutationAuthority,
  targetPath: string,
): string {
  return normalizeAbsolutePath(
    path.join(
      authority.trustedBaseCanonicalPath,
      path.relative(authority.trustedBaseLogicalPath, targetPath),
    ),
  );
}

async function assertLogicalChainSafe(options: {
  authority: MutationAuthority;
  targetPath: string;
  targetKind: 'directory' | 'file';
}): Promise<void> {
  const { authority } = options;
  await assertAuthorityIdentityCurrent(authority);
  const targetPath = normalizeAbsolutePath(options.targetPath);

  if (!isInsideOrEqual(authority.logicalMutationRoot, targetPath)) {
    throw new MutationBoundaryError(
      `Mutation target escapes its exact authority: ${targetPath}.`,
    );
  }
  if (
    authority.scope === 'file' &&
    targetPath !== authority.logicalMutationRoot
  ) {
    throw new MutationBoundaryError(
      `File mutation authority only permits its exact target: ${targetPath}.`,
    );
  }

  const relative = path.relative(authority.trustedBaseLogicalPath, targetPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new MutationBoundaryError(
      `Mutation target escapes its trusted base: ${targetPath}.`,
    );
  }

  let cursor = authority.trustedBaseLogicalPath;
  const segments = relative === '' ? [] : relative.split(path.sep);
  let missingAncestor = false;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    if (missingAncestor) continue;
    const stats = await lstatIfPresent(cursor);
    if (!stats) {
      missingAncestor = true;
      continue;
    }
    const final = index === segments.length - 1;
    if (!final || options.targetKind === 'directory') {
      assertOrdinaryDirectory(cursor, stats);
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new MutationBoundaryError(
        `Mutation target is a symbolic link or junction: ${cursor}.`,
      );
    }
    if (!stats.isFile()) {
      throw new MutationBoundaryError(
        `Mutation file target is not a regular file: ${cursor}.`,
      );
    }
  }

  const projected = projectedCanonicalPath(authority, targetPath);
  const allowedCanonicalRoot = authority.canonicalMutationRoot;
  if (!isInsideOrEqual(allowedCanonicalRoot, projected)) {
    throw new MutationBoundaryError(
      `Mutation target escapes its canonical authority: ${targetPath}.`,
    );
  }
  if (authority.scope === 'file' && projected !== allowedCanonicalRoot) {
    throw new MutationBoundaryError(
      `Mutation target does not match its canonical file authority: ${targetPath}.`,
    );
  }
}

export async function createExplicitMutationAuthority(options: {
  generation?: string;
  logicalMutationRoot: string;
  scope: MutationAuthorityScope;
  trustedBasePath: string;
}): Promise<MutationAuthority> {
  const trustedBaseLogicalPath = normalizeAbsolutePath(options.trustedBasePath);
  const logicalMutationRoot = normalizeAbsolutePath(
    options.logicalMutationRoot,
  );
  if (!isInsideOrEqual(trustedBaseLogicalPath, logicalMutationRoot)) {
    throw new MutationBoundaryError(
      `Exact mutation root is outside its explicit trusted base: ${logicalMutationRoot}.`,
    );
  }
  const trustedBaseIdentity = await captureTrustedBaseIdentity(
    trustedBaseLogicalPath,
  );
  const canonicalMutationRoot = normalizeAbsolutePath(
    path.join(
      trustedBaseIdentity.canonicalPath,
      path.relative(trustedBaseLogicalPath, logicalMutationRoot),
    ),
  );
  const authority = Object.freeze({
    [authorityBrand]: true as const,
    canonicalMutationRoot,
    generation: options.generation ?? randomUUID(),
    logicalMutationRoot,
    scope: options.scope,
    trustedBaseCanonicalPath: trustedBaseIdentity.canonicalPath,
    trustedBaseIdentity,
    trustedBaseLogicalPath,
  });
  authenticatedAuthorities.add(authority);
  await assertLogicalChainSafe({
    authority,
    targetKind: options.scope,
    targetPath: logicalMutationRoot,
  });
  return authority;
}

/**
 * Creates an exact authority outside an explicitly trusted workspace/package
 * root. A mechanically discovered symlink is deliberately kept below the
 * ordinary-directory anchor so the subsequent chain validation rejects it.
 */
export async function createMechanicalExactMutationAuthority(options: {
  generation?: string;
  logicalMutationRoot: string;
  scope: MutationAuthorityScope;
}): Promise<MutationAuthority> {
  const mutationRoot = normalizeAbsolutePath(options.logicalMutationRoot);
  let cursor = mutationRoot;

  for (;;) {
    const stats = await lstatIfPresent(cursor);
    if (stats) {
      if (stats.isSymbolicLink()) {
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          throw new MutationBoundaryError(
            `Unable to find an ordinary directory anchor for ${mutationRoot}.`,
          );
        }
        cursor = parent;
        continue;
      }
      if (!stats.isDirectory()) {
        throw new MutationBoundaryError(
          `Mechanical mutation anchor is not a directory: ${cursor}.`,
        );
      }
      return createExplicitMutationAuthority({
        generation: options.generation,
        logicalMutationRoot: mutationRoot,
        scope: options.scope,
        trustedBasePath: cursor,
      });
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new MutationBoundaryError(
        `Unable to find an existing directory anchor for ${mutationRoot}.`,
      );
    }
    cursor = parent;
  }
}

async function captureRegularFileIdentity(
  targetPath: string,
): Promise<RegularFileMutationIdentity> {
  const pathStats = await lstat(targetPath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new MutationBoundaryError(
      `Mutation file target is not an ordinary regular file: ${targetPath}.`,
    );
  }
  const handle = await open(targetPath, 'r');
  try {
    const before = await handle.stat();
    const content = await handle.readFile();
    const after = await handle.stat();
    const expected = statsIdentity(pathStats);
    const beforeIdentity = statsIdentity(before);
    const afterIdentity = statsIdentity(after);
    if (
      stableJson(expected) !== stableJson(beforeIdentity) ||
      stableJson(beforeIdentity) !== stableJson(afterIdentity) ||
      before.nlink !== after.nlink ||
      before.size !== after.size
    ) {
      throw new MutationBoundaryError(
        `Regular file identity drifted while it was inspected: ${targetPath}.`,
      );
    }
    return {
      ...beforeIdentity,
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

async function captureNodeIdentity(options: {
  authority: MutationAuthority;
  path: string;
}): Promise<MutationNodeIdentity> {
  const stats = await lstatIfPresent(options.path);
  if (!stats) {
    return {
      canonicalProjection: projectedCanonicalPath(
        options.authority,
        options.path,
      ),
      kind: 'missing',
      path: options.path,
    };
  }
  if (stats.isSymbolicLink()) {
    throw new MutationBoundaryError(
      `Mutation boundary contains a symbolic link or junction: ${options.path}.`,
    );
  }
  if (stats.isDirectory()) {
    return {
      ...statsIdentity(stats),
      canonicalPath: projectedCanonicalPath(options.authority, options.path),
      diagnosticNlink: Number(stats.nlink),
      kind: 'directory',
    };
  }
  if (stats.isFile()) return captureRegularFileIdentity(options.path);
  throw new MutationBoundaryError(
    `Mutation boundary contains an unsupported filesystem node: ${options.path}.`,
  );
}

async function walkDirectorySubtree(options: {
  authority: MutationAuthority;
  entries: Map<string, MutationNodeIdentity>;
  rootPath: string;
}): Promise<void> {
  const directory = await opendir(options.rootPath);
  for await (const entry of directory) {
    const entryPath = path.join(options.rootPath, entry.name);
    const identity = await captureNodeIdentity({
      authority: options.authority,
      path: entryPath,
    });
    options.entries.set(entryPath, identity);
    if (identity.kind === 'directory') {
      await walkDirectorySubtree({
        authority: options.authority,
        entries: options.entries,
        rootPath: entryPath,
      });
    }
  }
}

async function captureBoundarySnapshot(
  targets: readonly MutationBoundaryTarget[],
): Promise<MutationBoundarySnapshot> {
  const normalizedTargets = targets
    .map((target) => ({
      ...target,
      path: normalizeAbsolutePath(target.path),
    }))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.kind.localeCompare(right.kind),
    );
  const entries = new Map<string, MutationNodeIdentity>();
  const authorityFingerprints = new Set<string>();

  for (const target of normalizedTargets) {
    assertMutationAuthority(target.authority);
    authorityFingerprints.add(authorityFingerprint(target.authority));
    await assertLogicalChainSafe({
      authority: target.authority,
      targetKind: target.kind,
      targetPath: target.path,
    });
    const identity = await captureNodeIdentity({
      authority: target.authority,
      path: target.path,
    });
    if (target.kind === 'directory' && identity.kind === 'file') {
      throw new MutationBoundaryError(
        `Writable directory target is an existing regular file: ${target.path}.`,
      );
    }
    if (target.kind === 'file' && identity.kind === 'directory') {
      throw new MutationBoundaryError(
        `Writable file target is an existing directory: ${target.path}.`,
      );
    }
    entries.set(target.path, identity);
    if (
      target.kind === 'directory' &&
      target.recursive &&
      identity.kind === 'directory'
    ) {
      await walkDirectorySubtree({
        authority: target.authority,
        entries,
        rootPath: target.path,
      });
    }
  }

  const orderedEntries = [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryPath, identity]) => ({ identity, path: entryPath }));
  const orderedAuthorities = [...authorityFingerprints].sort();
  const stableEntries = orderedEntries.map(({ identity, path: entryPath }) => ({
    identity:
      identity.kind === 'directory'
        ? {
            canonicalPath: identity.canonicalPath,
            dev: identity.dev,
            ino: identity.ino,
            kind: identity.kind,
          }
        : identity,
    path: entryPath,
  }));
  const fingerprint = createHash('sha256')
    .update(stableJson({ authorities: orderedAuthorities, stableEntries }))
    .digest('hex');

  return {
    authorityFingerprints: orderedAuthorities,
    entries: orderedEntries,
    fingerprint,
    targets: normalizedTargets,
  };
}

/** Performs an all-target preflight and an immediate global recheck. */
export async function preflightMutationBoundary(
  targets: readonly MutationBoundaryTarget[],
): Promise<MutationBoundarySnapshot> {
  const prepared = await captureBoundarySnapshot(targets);
  const rechecked = await captureBoundarySnapshot(targets);
  if (prepared.fingerprint !== rechecked.fingerprint) {
    throw new MutationBoundaryError(
      'Filesystem mutation boundary drifted during batch preflight.',
    );
  }
  return rechecked;
}

export async function recheckMutationBoundary(
  snapshot: MutationBoundarySnapshot,
): Promise<void> {
  const current = await captureBoundarySnapshot(snapshot.targets);
  if (current.fingerprint !== snapshot.fingerprint) {
    throw new MutationBoundaryError(
      'Filesystem mutation boundary drifted after preflight.',
    );
  }
}
