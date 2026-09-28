import { readFile } from 'node:fs/promises';
import path from 'pathe';
import {
  type LiminaArtifactNamespace,
  resolveArtifactNamespacePath,
} from '../../domain/artifacts/namespace';
import type { CheckAttemptId } from '../../domain/shared/identifiers';
import type { CrossProcessLeaseOwner } from '../../utils/mutation/cross-process-lease';
import {
  isNonEmptyString,
  isPositiveInteger,
  isString,
  matchesRecordSchema,
} from '../../utils/validation/record-schema';

export interface CheckAttemptStarted {
  version: 1;
  attemptId: CheckAttemptId;
  command: string;
  owner: CrossProcessLeaseOwner;
  sequence: number;
  startedAt: string;
}

export interface LatestCheckAttempt {
  version: 1;
  attemptId: CheckAttemptId;
  sequence: number;
  startedAt: string;
}

export interface LatestCompletedCheckAttempt {
  version: 1;
  attemptId: CheckAttemptId;
  sequence: number;
  snapshotCreatedAt: string;
  snapshotHash: string;
}

export type CheckAttemptTerminalState =
  | 'aborted'
  | 'completed'
  | 'persistence-failed';

export interface CheckAttemptStatus {
  version: 1;
  attemptId: CheckAttemptId;
  error?: string;
  finishedAt: string;
  inventoryPublished: boolean;
  sequence: number;
  sourceSnapshotPersisted?: boolean;
  status: CheckAttemptTerminalState;
}

export interface PublishedCheckAttempt {
  latest: LatestCheckAttempt;
  started: CheckAttemptStarted;
}

export type ReadJsonResult<T> =
  | { status: 'missing' }
  | { status: 'corrupt' }
  | { status: 'valid'; value: T };

export interface CheckAttemptPaths {
  attemptsDir: string;
  checkDir: string;
  lastRun: string;
  latestAttempt: string;
  latestCompleted: string;
}

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isAttemptId(value: unknown): value is CheckAttemptId {
  return isNonEmptyString(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

export function isLatestAttempt(value: unknown): value is LatestCheckAttempt {
  return matchesRecordSchema(value, {
    attemptId: isAttemptId,
    sequence: isPositiveInteger,
    startedAt: isString,
    version: (candidate) => candidate === 1,
  });
}

export function isLatestCompleted(
  value: unknown,
): value is LatestCompletedCheckAttempt {
  return matchesRecordSchema(value, {
    attemptId: isAttemptId,
    sequence: isPositiveInteger,
    snapshotCreatedAt: isString,
    snapshotHash: isNonEmptyString,
    version: (candidate) => candidate === 1,
  });
}

function isOwner(value: unknown): value is CrossProcessLeaseOwner {
  return matchesRecordSchema(value, {
    hostname: isString,
    pid: isPositiveInteger,
    startedAt: isString,
    token: isString,
  });
}

export function isStarted(value: unknown): value is CheckAttemptStarted {
  return matchesRecordSchema(value, {
    attemptId: isAttemptId,
    command: isString,
    owner: isOwner,
    sequence: isPositiveInteger,
    startedAt: isString,
    version: (candidate) => candidate === 1,
  });
}

function isTerminalState(value: unknown): value is CheckAttemptTerminalState {
  return (
    value === 'completed' ||
    value === 'persistence-failed' ||
    value === 'aborted'
  );
}

export function isStatus(value: unknown): value is CheckAttemptStatus {
  return matchesRecordSchema(value, {
    attemptId: isAttemptId,
    error: isOptionalString,
    finishedAt: isString,
    inventoryPublished: (candidate) => typeof candidate === 'boolean',
    sequence: isPositiveInteger,
    sourceSnapshotPersisted: isOptionalBoolean,
    status: isTerminalState,
    version: (candidate) => candidate === 1,
  });
}

export async function readCheckAttemptJson<T>(
  filePath: string,
  validate: (value: unknown) => value is T,
): Promise<ReadJsonResult<T>> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    return validateJsonValue(value, validate);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { status: 'missing' };
    return { status: 'corrupt' };
  }
}

function validateJsonValue<T>(
  value: unknown,
  validate: (value: unknown) => value is T,
): ReadJsonResult<T> {
  return validate(value) ? { status: 'valid', value } : { status: 'corrupt' };
}

export function getCheckAttemptPaths(rootDir: string): CheckAttemptPaths {
  const checkDir = path.join(rootDir, '.limina', 'check');
  return {
    attemptsDir: path.join(checkDir, 'attempts'),
    checkDir,
    lastRun: path.join(checkDir, 'last-run.json'),
    latestAttempt: path.join(checkDir, 'latest-attempt.json'),
    latestCompleted: path.join(checkDir, 'latest-completed.json'),
  };
}

export function getAttemptPaths(
  namespace: LiminaArtifactNamespace,
  attemptId: CheckAttemptId,
): { started: string; status: string } {
  const base = ['check', 'attempts', attemptId] as const;
  return {
    started: resolveArtifactNamespacePath(namespace, ...base, 'started.json'),
    status: resolveArtifactNamespacePath(namespace, ...base, 'status.json'),
  };
}

export function getIndexPaths(namespace: LiminaArtifactNamespace): {
  latestAttempt: string;
  latestCompleted: string;
} {
  return {
    latestAttempt: resolveArtifactNamespacePath(
      namespace,
      'check',
      'latest-attempt.json',
    ),
    latestCompleted: resolveArtifactNamespacePath(
      namespace,
      'check',
      'latest-completed.json',
    ),
  };
}

export function isSameAttempt(
  left: LatestCheckAttempt,
  right:
    | CheckAttemptStarted
    | CheckAttemptStatus
    | LatestCheckAttempt
    | LatestCompletedCheckAttempt,
): boolean {
  return left.attemptId === right.attemptId && left.sequence === right.sequence;
}
