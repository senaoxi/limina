import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  type AtomicWriteOptions,
  writeJsonAtomically,
} from '../../check-reporting/atomic-writer';
import type { CheckIssueSnapshot } from '../../check-reporting/snapshot';
import type { LiminaArtifactNamespace } from '../../domain/artifacts/namespace';
import { identifier } from '../../domain/shared/identifiers';
import {
  acquireCrossProcessWriteLease,
  type CrossProcessLeaseOwner,
} from '../../utils/mutation/cross-process-lease';
import {
  getAttemptPaths,
  getIndexPaths,
  isLatestAttempt,
  isSameAttempt,
  type LatestCheckAttempt,
  type LatestCompletedCheckAttempt,
  type PublishedCheckAttempt,
  readCheckAttemptJson,
} from './check-attempt-metadata';
import { cleanupAttemptRetention } from './check-attempt-retention';
import {
  createAttemptStatus,
  persistFailureStatus,
  writeAttemptStatus,
} from './check-attempt-status';

export {
  abortCheckAttempt,
  failCheckAttemptPersistence,
} from './check-attempt-status';

export {
  getCheckAttemptPaths,
  isLatestAttempt,
  isLatestCompleted,
  isStarted,
  isStatus,
  readCheckAttemptJson,
} from './check-attempt-metadata';
export type {
  CheckAttemptPaths,
  CheckAttemptStarted,
  CheckAttemptStatus,
  CheckAttemptTerminalState,
  LatestCheckAttempt,
  LatestCompletedCheckAttempt,
  PublishedCheckAttempt,
  ReadJsonResult,
} from './check-attempt-metadata';

const CHECK_INDEX_LEASE = { leaseName: 'check-index' } as const;

export interface CompleteCheckAttemptOptions {
  attempt: PublishedCheckAttempt;
  namespace: LiminaArtifactNamespace;
  snapshot: CheckIssueSnapshot;
  sourceSnapshotPersisted: boolean;
  warn?: (message: string) => void;
  writeSnapshot(
    namespace: LiminaArtifactNamespace,
    snapshot: CheckIssueSnapshot,
  ): Promise<void>;
}

function ignoreError(error: unknown): void {
  String(error);
}

function createOwner(): CrossProcessLeaseOwner {
  return {
    hostname: hostname(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };
}

async function requireLatestAttempt(
  namespace: LiminaArtifactNamespace,
): Promise<LatestCheckAttempt | null> {
  const result = await readCheckAttemptJson(
    getIndexPaths(namespace).latestAttempt,
    isLatestAttempt,
  );
  if (result.status === 'missing') return null;
  if (result.status === 'corrupt') {
    throw new Error(
      'latest-attempt.json is corrupt; a check sequence cannot be allocated safely.',
    );
  }
  return result.value;
}

export async function publishCheckAttempt(options: {
  command: string;
  namespace: LiminaArtifactNamespace;
  atomicWriteOptions?: AtomicWriteOptions;
}): Promise<PublishedCheckAttempt> {
  const lease = await acquireCrossProcessWriteLease(
    options.namespace.canonicalRootDir,
    CHECK_INDEX_LEASE,
  );
  try {
    const previous = await requireLatestAttempt(options.namespace);
    const attemptId = identifier<'CheckAttemptId'>(randomUUID());
    const sequence = (previous?.sequence ?? 0) + 1;
    const startedAt = new Date().toISOString();
    const started = {
      version: 1,
      attemptId,
      command: options.command,
      owner: createOwner(),
      sequence,
      startedAt,
    } as const;
    const latest = { version: 1, attemptId, sequence, startedAt } as const;
    await writeJsonAtomically(
      options.namespace,
      getAttemptPaths(options.namespace, attemptId).started,
      started,
      options.atomicWriteOptions,
    );
    await writeJsonAtomically(
      options.namespace,
      getIndexPaths(options.namespace).latestAttempt,
      latest,
      options.atomicWriteOptions,
    );
    return { latest, started };
  } finally {
    await lease.release();
  }
}

export function hashCheckIssueSnapshot(snapshot: CheckIssueSnapshot): string {
  return createHash('sha256')
    .update(`${JSON.stringify(snapshot, null, 2)}\n`)
    .digest('hex');
}

async function writeSupersededStatus(
  options: CompleteCheckAttemptOptions,
): Promise<void> {
  await writeAttemptStatus({
    attempt: options.attempt,
    namespace: options.namespace,
    status: createAttemptStatus({
      attempt: options.attempt,
      inventoryPublished: false,
      sourceSnapshotPersisted: options.sourceSnapshotPersisted,
      status: 'completed',
    }),
  });
}

async function writeCompletedInventory(
  options: CompleteCheckAttemptOptions,
): Promise<void> {
  await options.writeSnapshot(options.namespace, options.snapshot);
  const completed: LatestCompletedCheckAttempt = {
    version: 1,
    attemptId: options.attempt.latest.attemptId,
    sequence: options.attempt.latest.sequence,
    snapshotCreatedAt: options.snapshot.createdAt,
    snapshotHash: hashCheckIssueSnapshot(options.snapshot),
  };
  await writeJsonAtomically(
    options.namespace,
    getIndexPaths(options.namespace).latestCompleted,
    completed,
  );
  await writeAttemptStatus({
    attempt: options.attempt,
    namespace: options.namespace,
    status: createAttemptStatus({
      attempt: options.attempt,
      inventoryPublished: true,
      sourceSnapshotPersisted: options.sourceSnapshotPersisted,
      status: 'completed',
    }),
  });
}

async function publishCompletedUnderLease(
  options: CompleteCheckAttemptOptions,
): Promise<void> {
  if (!(await prepareCompletedPublication(options))) return;
  try {
    await writeCompletedInventory(options);
  } catch (error) {
    await persistFailureStatus({
      attempt: options.attempt,
      error,
      namespace: options.namespace,
      sourceSnapshotPersisted: options.sourceSnapshotPersisted,
    }).catch(ignoreError);
    throw error;
  }
}

async function prepareCompletedPublication(
  options: CompleteCheckAttemptOptions,
): Promise<boolean> {
  const current = await requireLatestAttempt(options.namespace);
  if (current === null) {
    throw new Error('latest-attempt.json disappeared before completion.');
  }
  if (!isSameAttempt(current, options.attempt.latest)) {
    await writeSupersededStatus(options);
    return false;
  }
  return true;
}

export async function completeCheckAttempt(
  options: CompleteCheckAttemptOptions,
): Promise<void> {
  const lease = await acquireCrossProcessWriteLease(
    options.namespace.canonicalRootDir,
    CHECK_INDEX_LEASE,
  );
  try {
    await publishCompletedUnderLease(options);
  } finally {
    await lease.release();
  }
  await cleanupAttemptRetention(options.namespace).catch((error) => {
    options.warn?.(
      `Unable to clean old check attempt metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}
