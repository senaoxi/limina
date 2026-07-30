import { writeJsonAtomically } from '../../check-reporting/atomic-writer';
import type { LiminaArtifactNamespace } from '../../domain/artifacts/namespace';
import { acquireCrossProcessWriteLease } from '../../utils/mutation/cross-process-lease';
import {
  type CheckAttemptStatus,
  type CheckAttemptTerminalState,
  getAttemptPaths,
  type PublishedCheckAttempt,
} from './check-attempt-metadata';

const CHECK_INDEX_LEASE = { leaseName: 'check-index' } as const;

function formatError(error: unknown): { error?: string } {
  if (error === undefined) return {};
  return { error: error instanceof Error ? error.message : String(error) };
}

export function createAttemptStatus(options: {
  attempt: PublishedCheckAttempt;
  error?: unknown;
  inventoryPublished: boolean;
  sourceSnapshotPersisted?: boolean;
  status: CheckAttemptTerminalState;
}): CheckAttemptStatus {
  return {
    version: 1,
    attemptId: options.attempt.latest.attemptId,
    ...formatError(options.error),
    finishedAt: new Date().toISOString(),
    inventoryPublished: options.inventoryPublished,
    sequence: options.attempt.latest.sequence,
    ...(options.sourceSnapshotPersisted === undefined
      ? {}
      : { sourceSnapshotPersisted: options.sourceSnapshotPersisted }),
    status: options.status,
  };
}

export async function writeAttemptStatus(options: {
  attempt: PublishedCheckAttempt;
  namespace: LiminaArtifactNamespace;
  status: CheckAttemptStatus;
}): Promise<void> {
  await writeJsonAtomically(
    options.namespace,
    getAttemptPaths(options.namespace, options.attempt.latest.attemptId).status,
    options.status,
  );
}

export async function persistFailureStatus(options: {
  attempt: PublishedCheckAttempt;
  error: unknown;
  namespace: LiminaArtifactNamespace;
  sourceSnapshotPersisted: boolean;
}): Promise<void> {
  await writeAttemptStatus({
    attempt: options.attempt,
    namespace: options.namespace,
    status: createAttemptStatus({
      attempt: options.attempt,
      error: options.error,
      inventoryPublished: false,
      sourceSnapshotPersisted: options.sourceSnapshotPersisted,
      status: 'persistence-failed',
    }),
  });
}

export async function abortCheckAttempt(options: {
  attempt: PublishedCheckAttempt;
  error: unknown;
  namespace: LiminaArtifactNamespace;
}): Promise<void> {
  const lease = await acquireCrossProcessWriteLease(
    options.namespace.canonicalRootDir,
    CHECK_INDEX_LEASE,
  );
  try {
    await writeAttemptStatus({
      attempt: options.attempt,
      namespace: options.namespace,
      status: createAttemptStatus({
        attempt: options.attempt,
        error: options.error,
        inventoryPublished: false,
        status: 'aborted',
      }),
    });
  } finally {
    await lease.release();
  }
}

export async function failCheckAttemptPersistence(options: {
  attempt: PublishedCheckAttempt;
  error: unknown;
  namespace: LiminaArtifactNamespace;
  sourceSnapshotPersisted: boolean;
}): Promise<void> {
  const lease = await acquireCrossProcessWriteLease(
    options.namespace.canonicalRootDir,
    CHECK_INDEX_LEASE,
  );
  try {
    await persistFailureStatus(options);
  } finally {
    await lease.release();
  }
}
