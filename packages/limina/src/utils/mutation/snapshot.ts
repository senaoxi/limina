import { createHash } from 'node:crypto';
import { normalizeAbsolutePath } from '../path';
import {
  assertMutationAuthority,
  authorityFingerprint,
} from './authority-base';
import { assertLogicalChainSafe } from './authority-chain';
import { stableJson } from './boundary-shared';
import {
  MutationBoundaryError,
  type MutationBoundarySnapshot,
  type MutationBoundaryTarget,
  type MutationNodeIdentity,
} from './boundary-types';
import { captureNodeIdentity, walkDirectorySubtree } from './identity';

interface SnapshotState {
  authorityFingerprints: Set<string>;
  entries: Map<string, MutationNodeIdentity>;
}

function normalizeTargets(
  targets: readonly MutationBoundaryTarget[],
): MutationBoundaryTarget[] {
  return targets
    .map((target) => ({
      ...target,
      path: normalizeAbsolutePath(target.path),
    }))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.kind.localeCompare(right.kind),
    );
}

function isDirectoryTargetFile(
  target: MutationBoundaryTarget,
  identity: MutationNodeIdentity,
): boolean {
  return target.kind === 'directory' && identity.kind === 'file';
}

function isFileTargetDirectory(
  target: MutationBoundaryTarget,
  identity: MutationNodeIdentity,
): boolean {
  return target.kind === 'file' && identity.kind === 'directory';
}

function assertTargetIdentityKind(
  target: MutationBoundaryTarget,
  identity: MutationNodeIdentity,
): void {
  if (isDirectoryTargetFile(target, identity)) {
    throw new MutationBoundaryError(
      `Writable directory target is an existing regular file: ${target.path}.`,
    );
  }

  if (isFileTargetDirectory(target, identity)) {
    throw new MutationBoundaryError(
      `Writable file target is an existing directory: ${target.path}.`,
    );
  }
}

function shouldWalkTarget(
  target: MutationBoundaryTarget,
  identity: MutationNodeIdentity,
): boolean {
  return (
    target.kind === 'directory' &&
    target.recursive === true &&
    identity.kind === 'directory'
  );
}

async function captureTarget(
  target: MutationBoundaryTarget,
  state: SnapshotState,
): Promise<void> {
  assertMutationAuthority(target.authority);
  state.authorityFingerprints.add(authorityFingerprint(target.authority));
  await assertLogicalChainSafe({
    authority: target.authority,
    targetKind: target.kind,
    targetPath: target.path,
  });
  const identity = await captureNodeIdentity({
    authority: target.authority,
    path: target.path,
  });
  assertTargetIdentityKind(target, identity);
  state.entries.set(target.path, identity);

  if (shouldWalkTarget(target, identity)) {
    await walkDirectorySubtree({
      authority: target.authority,
      entries: state.entries,
      rootPath: target.path,
    });
  }
}

function createOrderedEntries(
  entries: ReadonlyMap<string, MutationNodeIdentity>,
): MutationBoundarySnapshot['entries'] {
  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryPath, identity]) => ({ identity, path: entryPath }));
}

function createStableIdentity(
  identity: MutationNodeIdentity,
): MutationNodeIdentity | Omit<MutationNodeIdentity, 'diagnosticNlink'> {
  if (identity.kind !== 'directory') {
    return identity;
  }

  return {
    canonicalPath: identity.canonicalPath,
    dev: identity.dev,
    ino: identity.ino,
    kind: identity.kind,
  };
}

function createStableEntries(
  entries: MutationBoundarySnapshot['entries'],
): unknown[] {
  return entries.map((entry) => ({
    identity: createStableIdentity(entry.identity),
    path: entry.path,
  }));
}

function createSnapshotFingerprint(options: {
  authorities: readonly string[];
  entries: MutationBoundarySnapshot['entries'];
}): string {
  return createHash('sha256')
    .update(
      stableJson({
        authorities: options.authorities,
        stableEntries: createStableEntries(options.entries),
      }),
    )
    .digest('hex');
}

async function captureBoundarySnapshot(
  targets: readonly MutationBoundaryTarget[],
): Promise<MutationBoundarySnapshot> {
  const normalizedTargets = normalizeTargets(targets);
  const state: SnapshotState = {
    authorityFingerprints: new Set(),
    entries: new Map(),
  };

  for (const target of normalizedTargets) {
    await captureTarget(target, state);
  }

  const entries = createOrderedEntries(state.entries);
  const authorityFingerprints = [...state.authorityFingerprints].sort();
  return {
    authorityFingerprints,
    entries,
    fingerprint: createSnapshotFingerprint({
      authorities: authorityFingerprints,
      entries,
    }),
    targets: normalizedTargets,
  };
}

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
