import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createLiminaArtifactNamespace,
  resolveArtifactNamespacePath,
} from '../../domain/artifacts/namespace';
import {
  isLatestCompleted,
  isSameAttempt,
  type LatestCheckAttempt,
  type LatestCompletedCheckAttempt,
  readCheckAttemptJson,
} from './check-attempt-metadata';
import type { CheckAttemptQueryResult } from './check-attempt-query-types';
import { readCheckIssueSnapshot } from './check-io';
import { CHECK_ISSUE_SNAPSHOT_VERSION } from './types';

export function inconsistentCheckAttemptResult(
  reason: string,
): CheckAttemptQueryResult {
  return {
    message: `The latest completed check inventory is inconsistent (${reason}); refusing to return issues.`,
    snapshot: null,
    state: 'completed-inconsistent',
  };
}

type CompletedPointerRead =
  | { status: 'invalid'; result: CheckAttemptQueryResult }
  | { status: 'valid'; value: LatestCompletedCheckAttempt };

async function readCompletedPointer(options: {
  latest: LatestCheckAttempt;
  latestCompletedPath: string;
}): Promise<CompletedPointerRead> {
  const completed = await readCheckAttemptJson(
    options.latestCompletedPath,
    isLatestCompleted,
  );
  if (completed.status !== 'valid') {
    return {
      result: inconsistentCheckAttemptResult(
        'latest-completed.json is missing or corrupt',
      ),
      status: 'invalid',
    };
  }
  if (!isSameAttempt(options.latest, completed.value)) {
    return {
      result: inconsistentCheckAttemptResult(
        'attempt identity or sequence does not match',
      ),
      status: 'invalid',
    };
  }
  return { status: 'valid', value: completed.value };
}

async function readRawSnapshot(rootDirectory: string): Promise<string | null> {
  const snapshotPath = resolveArtifactNamespacePath(
    createLiminaArtifactNamespace({ generation: 0, rootDir: rootDirectory }),
    'check',
    'last-run.json',
  );
  try {
    return await readFile(snapshotPath, 'utf8');
  } catch {
    return null;
  }
}

function hashSnapshotText(rawSnapshot: string): string {
  return createHash('sha256').update(rawSnapshot).digest('hex');
}

async function readValidatedSnapshot(
  rootDirectory: string,
  completed: LatestCompletedCheckAttempt,
): Promise<CheckAttemptQueryResult> {
  const snapshot = await readCheckIssueSnapshot(rootDirectory);
  if (snapshot === null) {
    return inconsistentCheckAttemptResult(
      `last-run.json is not a valid v${CHECK_ISSUE_SNAPSHOT_VERSION} snapshot`,
    );
  }
  return snapshot.createdAt === completed.snapshotCreatedAt
    ? { snapshot, state: 'completed' }
    : inconsistentCheckAttemptResult('snapshot timestamp does not match');
}

async function readSnapshotForPointer(
  rootDirectory: string,
  completed: LatestCompletedCheckAttempt,
): Promise<CheckAttemptQueryResult> {
  const rawSnapshot = await readRawSnapshot(rootDirectory);
  if (rawSnapshot === null) {
    return inconsistentCheckAttemptResult(
      'last-run.json is missing or unreadable',
    );
  }
  return hashSnapshotText(rawSnapshot) === completed.snapshotHash
    ? readValidatedSnapshot(rootDirectory, completed)
    : inconsistentCheckAttemptResult(
        'last-run.json content hash does not match',
      );
}

export async function readCompletedCheckSnapshot(options: {
  latest: LatestCheckAttempt;
  latestCompletedPath: string;
  rootDir: string;
}): Promise<CheckAttemptQueryResult> {
  const completed = await readCompletedPointer(options);
  return completed.status === 'invalid'
    ? completed.result
    : readSnapshotForPointer(options.rootDir, completed.value);
}
