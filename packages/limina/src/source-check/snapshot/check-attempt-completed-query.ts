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

async function readRawSnapshot(rootDir: string): Promise<string | null> {
  const snapshotPath = resolveArtifactNamespacePath(
    createLiminaArtifactNamespace({ generation: 0, rootDir }),
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
  rootDir: string,
  completed: LatestCompletedCheckAttempt,
): Promise<CheckAttemptQueryResult> {
  const snapshot = await readCheckIssueSnapshot(rootDir);
  if (snapshot === null) {
    return inconsistentCheckAttemptResult(
      'last-run.json is not a valid v7 snapshot',
    );
  }
  if (snapshot.createdAt !== completed.snapshotCreatedAt) {
    return inconsistentCheckAttemptResult('snapshot timestamp does not match');
  }
  return { snapshot, state: 'completed' };
}

async function readSnapshotForPointer(
  rootDir: string,
  completed: LatestCompletedCheckAttempt,
): Promise<CheckAttemptQueryResult> {
  const rawSnapshot = await readRawSnapshot(rootDir);
  if (rawSnapshot === null) {
    return inconsistentCheckAttemptResult(
      'last-run.json is missing or unreadable',
    );
  }
  if (hashSnapshotText(rawSnapshot) !== completed.snapshotHash) {
    return inconsistentCheckAttemptResult(
      'last-run.json content hash does not match',
    );
  }
  return readValidatedSnapshot(rootDir, completed);
}

export async function readCompletedCheckSnapshot(options: {
  latest: LatestCheckAttempt;
  latestCompletedPath: string;
  rootDir: string;
}): Promise<CheckAttemptQueryResult> {
  const completed = await readCompletedPointer(options);
  if (completed.status === 'invalid') return completed.result;
  return readSnapshotForPointer(options.rootDir, completed.value);
}
