import { randomUUID } from 'node:crypto';
import path from 'pathe';
import { normalizeAbsolutePath } from '../path';
import {
  authenticateMutationAuthority,
  captureTrustedBaseIdentity,
} from './authority-base';
import { assertLogicalChainSafe } from './authority-chain';
import { isInsideOrEqual, lstatIfPresent } from './boundary-shared';
import type {
  MutationAuthority,
  MutationAuthorityScope,
  TrustedBaseIdentity,
} from './boundary-types';
import {
  mutationAuthorityBrand,
  MutationBoundaryError,
} from './boundary-types';

function createAuthority(options: {
  generation: string;
  logicalMutationRoot: string;
  scope: MutationAuthorityScope;
  trustedBaseIdentity: TrustedBaseIdentity;
  trustedBaseLogicalPath: string;
}): MutationAuthority {
  const canonicalMutationRoot = normalizeAbsolutePath(
    path.join(
      options.trustedBaseIdentity.canonicalPath,
      path.relative(
        options.trustedBaseLogicalPath,
        options.logicalMutationRoot,
      ),
    ),
  );
  return Object.freeze({
    [mutationAuthorityBrand]: true as const,
    canonicalMutationRoot,
    generation: options.generation,
    logicalMutationRoot: options.logicalMutationRoot,
    scope: options.scope,
    trustedBaseCanonicalPath: options.trustedBaseIdentity.canonicalPath,
    trustedBaseIdentity: options.trustedBaseIdentity,
    trustedBaseLogicalPath: options.trustedBaseLogicalPath,
  });
}

function assertMutationRootWithinBase(options: {
  logicalMutationRoot: string;
  trustedBaseLogicalPath: string;
}): void {
  if (
    !isInsideOrEqual(
      options.trustedBaseLogicalPath,
      options.logicalMutationRoot,
    )
  ) {
    throw new MutationBoundaryError(
      `Exact mutation root is outside its explicit trusted base: ${options.logicalMutationRoot}.`,
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
  assertMutationRootWithinBase({
    logicalMutationRoot,
    trustedBaseLogicalPath,
  });
  const authority = createAuthority({
    generation: options.generation ?? randomUUID(),
    logicalMutationRoot,
    scope: options.scope,
    trustedBaseIdentity: await captureTrustedBaseIdentity(
      trustedBaseLogicalPath,
    ),
    trustedBaseLogicalPath,
  });
  authenticateMutationAuthority(authority);
  await assertLogicalChainSafe({
    authority,
    targetKind: options.scope,
    targetPath: logicalMutationRoot,
  });
  return authority;
}

function getParentPath(targetPath: string, errorMessage: string): string {
  const parent = path.dirname(targetPath);

  if (parent === targetPath) {
    throw new MutationBoundaryError(errorMessage);
  }

  return parent;
}

function requiresParentAnchor(
  stats: Awaited<ReturnType<typeof lstatIfPresent>>,
): boolean {
  return stats === undefined || stats.isSymbolicLink();
}

function getAnchorFailureMessage(
  stats: Awaited<ReturnType<typeof lstatIfPresent>>,
  mutationRoot: string,
): string {
  return stats === undefined
    ? `Unable to find an existing directory anchor for ${mutationRoot}.`
    : `Unable to find an ordinary directory anchor for ${mutationRoot}.`;
}

async function resolveMechanicalAnchorFrom(
  cursor: string,
  mutationRoot: string,
): Promise<string> {
  const stats = await lstatIfPresent(cursor);

  if (requiresParentAnchor(stats)) {
    return resolveMechanicalAnchorFrom(
      getParentPath(cursor, getAnchorFailureMessage(stats, mutationRoot)),
      mutationRoot,
    );
  }

  if (!stats!.isDirectory()) {
    throw new MutationBoundaryError(
      `Mechanical mutation anchor is not a directory: ${cursor}.`,
    );
  }

  return cursor;
}

export async function createMechanicalExactMutationAuthority(options: {
  generation?: string;
  logicalMutationRoot: string;
  scope: MutationAuthorityScope;
}): Promise<MutationAuthority> {
  const mutationRoot = normalizeAbsolutePath(options.logicalMutationRoot);
  return createExplicitMutationAuthority({
    generation: options.generation,
    logicalMutationRoot: mutationRoot,
    scope: options.scope,
    trustedBasePath: await resolveMechanicalAnchorFrom(
      mutationRoot,
      mutationRoot,
    ),
  });
}
