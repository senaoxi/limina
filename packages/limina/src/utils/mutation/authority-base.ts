import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { normalizeAbsolutePath } from '../path';
import { stableJson, statsIdentity } from './boundary-shared';
import {
  type MutationAuthority,
  MutationBoundaryError,
  type TrustedBaseIdentity,
} from './boundary-types';

const authenticatedAuthorities = new WeakSet<object>();
type FileSystemStats = Awaited<ReturnType<typeof lstat>>;

function createLogicalEntry(options: {
  identity: { dev: string; ino: string };
  isAlias: boolean;
  linkTarget: string | undefined;
}): TrustedBaseIdentity['logicalEntry'] {
  if (!options.isAlias) {
    return { ...options.identity, kind: 'directory' };
  }

  return {
    ...options.identity,
    kind: 'symlink',
    linkTarget: options.linkTarget,
  };
}

function assertTrustedBaseLogicalType(
  logicalPath: string,
  logicalStats: FileSystemStats,
): void {
  if (logicalStats.isSymbolicLink()) {
    return;
  }

  if (!logicalStats.isDirectory()) {
    throw new MutationBoundaryError(
      `Trusted mutation base is not a directory: ${logicalPath}.`,
    );
  }
}

function assertCanonicalBaseType(
  logicalPath: string,
  canonicalStats: Awaited<ReturnType<typeof stat>>,
): void {
  if (!canonicalStats.isDirectory()) {
    throw new MutationBoundaryError(
      `Trusted mutation base does not resolve to a directory: ${logicalPath}.`,
    );
  }
}

export async function captureTrustedBaseIdentity(
  trustedBasePath: string,
): Promise<TrustedBaseIdentity> {
  const logicalPath = normalizeAbsolutePath(trustedBasePath);
  const logicalStats = await lstat(logicalPath);
  assertTrustedBaseLogicalType(logicalPath, logicalStats);
  const isAlias = logicalStats.isSymbolicLink();
  const canonicalPath = normalizeAbsolutePath(await realpath(logicalPath));
  const canonicalStats = await stat(canonicalPath);
  assertCanonicalBaseType(logicalPath, canonicalStats);

  return {
    canonicalPath,
    canonicalTarget: {
      ...statsIdentity(canonicalStats),
      kind: 'directory',
    },
    logicalEntry: createLogicalEntry({
      identity: statsIdentity(logicalStats),
      isAlias,
      linkTarget: isAlias ? await readlink(logicalPath) : undefined,
    }),
  };
}

export function authorityFingerprint(authority: MutationAuthority): string {
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

export function authenticateMutationAuthority(
  authority: MutationAuthority,
): void {
  authenticatedAuthorities.add(authority);
}

export function assertMutationAuthority(authority: MutationAuthority): void {
  if (!authenticatedAuthorities.has(authority)) {
    throw new MutationBoundaryError(
      'Unauthenticated filesystem mutation authority.',
    );
  }
}

export async function assertAuthorityIdentityCurrent(
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
