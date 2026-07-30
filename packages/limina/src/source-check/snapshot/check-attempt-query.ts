import {
  createLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
  resolveArtifactNamespacePath,
} from '../../domain/artifacts/namespace';
import { acquireCrossProcessReadLease } from '../../utils/mutation/cross-process-lease';
import {
  inconsistentCheckAttemptResult,
  readCompletedCheckSnapshot,
} from './check-attempt-completed-query';
import {
  type CheckAttemptStarted,
  type CheckAttemptStatus,
  isLatestAttempt,
  isLatestCompleted,
  isStarted,
  isStatus,
  type LatestCheckAttempt,
  readCheckAttemptJson,
  type ReadJsonResult,
} from './check-attempt-io';
import { isSameAttempt } from './check-attempt-metadata';
import { getIncompleteAttemptResult } from './check-attempt-owner-query';
import type { CheckAttemptQueryResult } from './check-attempt-query-types';
import { readCheckIssueSnapshot } from './check-io';

export type {
  CheckAttemptQueryResult,
  CheckAttemptQueryState,
} from './check-attempt-query-types';

const CHECK_INDEX_LEASE = { leaseName: 'check-index' } as const;

function terminalFailureResult(
  status: CheckAttemptStatus,
): CheckAttemptQueryResult {
  if (status.status === 'aborted') {
    return {
      message:
        'The latest check attempt was aborted; refusing to return an older issue inventory.',
      snapshot: null,
      state: 'aborted',
    };
  }
  return {
    message:
      'The latest check attempt could not persist its completed inventory; refusing to return older issues.',
    snapshot: null,
    state: 'persistence-failed',
  };
}

type LatestAttemptRead =
  | { status: 'result'; result: CheckAttemptQueryResult }
  | { status: 'valid'; value: LatestCheckAttempt };

async function readLatestAttempt(
  namespace: LiminaArtifactNamespace,
  rootDir: string,
): Promise<LatestAttemptRead> {
  const latest = await readCheckAttemptJson(
    resolveArtifactNamespacePath(namespace, 'check', 'latest-attempt.json'),
    isLatestAttempt,
  );
  if (latest.status === 'missing') {
    return readLegacyAttempt(namespace, rootDir);
  }
  if (latest.status === 'corrupt') {
    return {
      result: {
        message:
          'latest-attempt.json is corrupt; refusing to return issues or infer check freshness.',
        snapshot: null,
        state: 'latest-attempt-corrupt',
      },
      status: 'result',
    };
  }
  return { status: 'valid', value: latest.value };
}

async function readLegacyAttempt(
  namespace: LiminaArtifactNamespace,
  rootDir: string,
): Promise<LatestAttemptRead> {
  const completed = await readCheckAttemptJson(
    resolveArtifactNamespacePath(namespace, 'check', 'latest-completed.json'),
    isLatestCompleted,
  );
  if (completed.status === 'missing') {
    return {
      result: {
        snapshot: await readCheckIssueSnapshot(rootDir),
        state: 'legacy',
      },
      status: 'result',
    };
  }
  return {
    result: {
      message:
        'latest-attempt.json is missing while completed-attempt metadata exists; refusing to return issues or infer check freshness.',
      snapshot: null,
      state: 'latest-attempt-corrupt',
    },
    status: 'result',
  };
}

type StartedAttemptRead =
  | { status: 'result'; result: CheckAttemptQueryResult }
  | { status: 'valid'; value: CheckAttemptStarted };

async function readStartedAttempt(
  attemptDir: string,
  latest: LatestCheckAttempt,
): Promise<StartedAttemptRead> {
  const started = await readCheckAttemptJson(
    `${attemptDir}/started.json`,
    isStarted,
  );
  if (started.status === 'valid' && isSameAttempt(latest, started.value)) {
    return { status: 'valid', value: started.value };
  }
  return {
    result: {
      message:
        'The latest check attempt metadata is incomplete or corrupt; refusing to return older issues.',
      snapshot: null,
      state: 'incomplete',
    },
    status: 'result',
  };
}

function isMatchingStatus(
  status: ReadJsonResult<CheckAttemptStatus>,
  latest: LatestCheckAttempt,
): status is { status: 'valid'; value: CheckAttemptStatus } {
  return status.status === 'valid' && isSameAttempt(latest, status.value);
}

async function readTerminalStatus(options: {
  attemptDir: string;
  latest: LatestCheckAttempt;
  started: CheckAttemptStarted;
}): Promise<CheckAttemptQueryResult | CheckAttemptStatus> {
  const status = await readCheckAttemptJson(
    `${options.attemptDir}/status.json`,
    isStatus,
  );
  if (status.status === 'missing') {
    return getIncompleteAttemptResult(options.started);
  }
  if (!isMatchingStatus(status, options.latest)) {
    return {
      message:
        'The latest check terminal metadata is corrupt; refusing to return older issues.',
      snapshot: null,
      state: 'incomplete',
    };
  }
  return status.value;
}

function isQueryResult(
  value: CheckAttemptQueryResult | CheckAttemptStatus,
): value is CheckAttemptQueryResult {
  return 'snapshot' in value;
}

function validateCompletedStatus(
  status: CheckAttemptStatus,
): CheckAttemptQueryResult | null {
  if (status.status !== 'completed') return terminalFailureResult(status);
  if (!status.inventoryPublished) {
    return inconsistentCheckAttemptResult(
      'the latest attempt did not publish inventory',
    );
  }
  return null;
}

async function readTerminalAttemptQuery(options: {
  attemptDir: string;
  latest: LatestCheckAttempt;
  namespace: LiminaArtifactNamespace;
  rootDir: string;
  started: CheckAttemptStarted;
}): Promise<CheckAttemptQueryResult> {
  const status = await readTerminalStatus(options);
  if (isQueryResult(status)) return status;
  const invalidStatus = validateCompletedStatus(status);
  if (invalidStatus !== null) return invalidStatus;
  return readCompletedCheckSnapshot({
    latest: options.latest,
    latestCompletedPath: resolveArtifactNamespacePath(
      options.namespace,
      'check',
      'latest-completed.json',
    ),
    rootDir: options.rootDir,
  });
}

async function readPublishedAttemptQuery(options: {
  latest: LatestCheckAttempt;
  namespace: LiminaArtifactNamespace;
  rootDir: string;
}): Promise<CheckAttemptQueryResult> {
  const attemptDir = resolveArtifactNamespacePath(
    options.namespace,
    'check',
    'attempts',
    options.latest.attemptId,
  );
  const started = await readStartedAttempt(attemptDir, options.latest);
  if (started.status === 'result') return started.result;
  return readTerminalAttemptQuery({
    attemptDir,
    latest: options.latest,
    namespace: options.namespace,
    rootDir: options.rootDir,
    started: started.value,
  });
}

async function readAttemptQueryUnderLease(
  rootDir: string,
): Promise<CheckAttemptQueryResult> {
  const namespace = createLiminaArtifactNamespace({ generation: 0, rootDir });
  const latest = await readLatestAttempt(namespace, rootDir);
  if (latest.status === 'result') return latest.result;
  return readPublishedAttemptQuery({
    latest: latest.value,
    namespace,
    rootDir,
  });
}

export async function queryLatestCheckAttempt(
  rootDir: string,
): Promise<CheckAttemptQueryResult> {
  const namespace = createLiminaArtifactNamespace({ generation: 0, rootDir });
  const lease = await acquireCrossProcessReadLease(
    namespace.canonicalRootDir,
    CHECK_INDEX_LEASE,
  );
  try {
    return await readAttemptQueryUnderLease(rootDir);
  } finally {
    await lease.release();
  }
}
