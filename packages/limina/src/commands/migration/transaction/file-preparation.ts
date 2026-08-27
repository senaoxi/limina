import type { FileHandle } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import {
  assertContentMatches,
  assertEqual,
  createPreparedIdentity,
  hashBytes,
  normalizeStat,
} from './file-stat';
import type {
  MigrationTransactionOptions,
  ModifiedTargetSnapshot,
  PreparedFileIdentity,
} from './types';

function getOwnership(
  snapshot: ModifiedTargetSnapshot,
): { gid: number; uid: number } | null {
  const values = [
    process.platform !== 'win32',
    snapshot.stat.chownUid !== undefined,
    snapshot.stat.chownGid !== undefined,
  ];
  if (!values.every(Boolean)) return null;
  return {
    gid: snapshot.stat.chownGid!,
    uid: snapshot.stat.chownUid!,
  };
}

async function applyOwnership(
  handle: FileHandle,
  snapshot: ModifiedTargetSnapshot,
): Promise<void> {
  const ownership = getOwnership(snapshot);
  if (ownership === null) return;
  await handle.chown(ownership.uid, ownership.gid);
}

export async function restoreOriginalTimestamp(
  handle: FileHandle,
  snapshot: ModifiedTargetSnapshot,
): Promise<void> {
  const atimeSeconds = (snapshot.stat.atimeMs + 0.5) / 1000;
  const mtimeSeconds = (snapshot.stat.timestamp.restorableMtimeMs + 0.5) / 1000;
  await handle.utimes(atimeSeconds, mtimeSeconds);
}

export async function applySupportedMetadata(options: {
  handle: FileHandle;
  restoreTimestamp: boolean;
  snapshot: ModifiedTargetSnapshot;
}): Promise<void> {
  await applyOwnership(options.handle, options.snapshot);
  await options.handle.chmod(options.snapshot.stat.permissionMode);
  if (options.restoreTimestamp) {
    await restoreOriginalTimestamp(options.handle, options.snapshot);
  }
}

export type PreparedFileMetadataProfile =
  | { kind: 'private-artifact' }
  | { kind: 'target-metadata'; restoreTimestamp: boolean };

async function applyPreparedFileMetadata(options: {
  handle: FileHandle;
  metadataProfile: PreparedFileMetadataProfile;
  snapshot: ModifiedTargetSnapshot;
}): Promise<void> {
  if (options.metadataProfile.kind === 'private-artifact') {
    if (process.platform !== 'win32') await options.handle.chmod(0o600);
    return;
  }
  await applySupportedMetadata({
    handle: options.handle,
    restoreTimestamp: options.metadataProfile.restoreTimestamp,
    snapshot: options.snapshot,
  });
}

async function closePreparedHandle(options: {
  handle: FileHandle;
  trackedHandles: Set<FileHandle>;
}): Promise<void> {
  await options.handle.close();
  options.trackedHandles.delete(options.handle);
}

async function closeAfterFailure(options: {
  handle: FileHandle;
  trackedHandles: Set<FileHandle>;
}): Promise<void> {
  try {
    await options.handle.close();
  } catch {
    // Preserve the preparation failure as the primary error.
  }
  options.trackedHandles.delete(options.handle);
}

async function writePreparedFile(options: {
  bytes: Buffer;
  filePath: string;
  handle: FileHandle;
  metadataProfile: PreparedFileMetadataProfile;
  snapshot: ModifiedTargetSnapshot;
  trackedHandles: Set<FileHandle>;
}): Promise<void> {
  try {
    await options.handle.writeFile(options.bytes);
    await applyPreparedFileMetadata(options);
    await options.handle.sync();
    await closePreparedHandle(options);
  } catch (error) {
    await closeAfterFailure(options);
    throw error;
  }
}

function assertPrivateArtifactMetadata(options: {
  filePath: string;
  identity: PreparedFileIdentity;
}): void {
  if (process.platform === 'win32') return;
  assertEqual({
    actual: options.identity.stat.permissionMode,
    expected: 0o600,
    filePath: options.filePath,
    label: 'private artifact permission mode',
  });
}

function assertTargetMetadata(options: {
  filePath: string;
  identity: PreparedFileIdentity;
  restoreTimestamp: boolean;
  snapshot: ModifiedTargetSnapshot;
}): void {
  const fields: readonly [unknown, unknown, string][] = [
    [
      options.identity.stat.permissionMode,
      options.snapshot.stat.permissionMode,
      'permission mode',
    ],
    [options.identity.stat.uid, options.snapshot.stat.uid, 'uid'],
    [options.identity.stat.gid, options.snapshot.stat.gid, 'gid'],
  ];
  for (const [actual, expected, label] of fields) {
    assertEqual({ actual, expected, filePath: options.filePath, label });
  }
  if (options.restoreTimestamp) {
    assertEqual({
      actual: options.identity.stat.timestamp.restorableMtimeMs,
      expected: options.snapshot.stat.timestamp.restorableMtimeMs,
      filePath: options.filePath,
      label: 'restorable mtime',
    });
  }
}

function assertPreparedMetadata(options: {
  filePath: string;
  identity: PreparedFileIdentity;
  metadataProfile: PreparedFileMetadataProfile;
  snapshot: ModifiedTargetSnapshot;
}): void {
  if (options.metadataProfile.kind === 'private-artifact') {
    assertPrivateArtifactMetadata(options);
    return;
  }
  assertTargetMetadata({
    filePath: options.filePath,
    identity: options.identity,
    restoreTimestamp: options.metadataProfile.restoreTimestamp,
    snapshot: options.snapshot,
  });
}

export async function prepareFile(options: {
  bytes: Buffer;
  filePath: string;
  metadataProfile: PreparedFileMetadataProfile;
  openFile: NonNullable<MigrationTransactionOptions['openFile']>;
  readFileBytes: NonNullable<MigrationTransactionOptions['readFileBytes']>;
  snapshot: ModifiedTargetSnapshot;
  trackedHandles: Set<FileHandle>;
}): Promise<PreparedFileIdentity> {
  const handle = await options.openFile(options.filePath, 'wx', 0o600);
  options.trackedHandles.add(handle);
  await writePreparedFile({ ...options, handle });
  const preparedStat = normalizeStat(
    await stat(options.filePath, { bigint: true }),
  );
  const bytes = await options.readFileBytes(options.filePath);
  const identity = createPreparedIdentity(bytes, preparedStat);
  assertContentMatches({
    bytes,
    expected: hashBytes(options.bytes),
    filePath: options.filePath,
  });
  assertPreparedMetadata({
    filePath: options.filePath,
    identity,
    metadataProfile: options.metadataProfile,
    snapshot: options.snapshot,
  });
  return identity;
}
