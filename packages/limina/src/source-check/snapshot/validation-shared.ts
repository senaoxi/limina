import { isPlainRecord } from '#utils/values';
import {
  type CheckIssueSnapshotStatus,
  LIMINA_CHECK_TASK_NAMES,
  type LiminaCheckIssueSeverity,
  type LiminaCheckRunCheckItemStatus,
  type LiminaCheckRunResult,
  type LiminaCheckRunTaskKind,
  type LiminaCheckRunTaskStatus,
  type LiminaCheckTaskName,
  type SourceIssueSnapshotStatus,
} from './types';

export const CHECKER_TARGET_ID_PATTERN: RegExp =
  /^checker-target:[a-f0-9]{64}$/u;

export function isAllValid(values: readonly boolean[]): boolean {
  return values.every(Boolean);
}

export function firstProblem(
  problems: readonly (string | null)[],
): string | null {
  const problem = problems.find((entry) => entry !== null);
  return problem === undefined ? null : problem;
}

export function problemWhen(
  isCondition: boolean,
  message: string,
): string | null {
  return isCondition ? message : null;
}

const SOURCE_SNAPSHOT_STATUSES = new Set<SourceIssueSnapshotStatus>([
  'completed',
  'not-run',
]);
const CHECK_SNAPSHOT_STATUSES = new Set<CheckIssueSnapshotStatus>([
  'completed',
  'not-run',
]);
const ISSUE_SEVERITIES = new Set<LiminaCheckIssueSeverity>([
  'error',
  'info',
  'warning',
]);
const RUN_RESULTS = new Set<LiminaCheckRunResult>([
  'blocked',
  'failed',
  'not-run',
  'passed',
  'running',
]);
const TASK_KINDS = new Set<LiminaCheckRunTaskKind>([
  'command',
  'preparation',
  'task',
]);
const CHECK_ITEM_STATUSES = new Set<LiminaCheckRunCheckItemStatus>([
  'blocked',
  'disabled',
  'failed',
  'passed',
  'skipped',
]);
const TASK_STATUSES = new Set<LiminaCheckRunTaskStatus>([
  'blocked',
  'disabled',
  'failed',
  'passed',
  'planned',
  'running',
  'skipped',
]);
const ISSUE_TASKS = new Set<string>(LIMINA_CHECK_TASK_NAMES);

export function isSourceIssueSnapshotStatus(
  value: unknown,
): value is SourceIssueSnapshotStatus {
  return SOURCE_SNAPSHOT_STATUSES.has(value as SourceIssueSnapshotStatus);
}

export function isCheckIssueSnapshotStatus(
  value: unknown,
): value is CheckIssueSnapshotStatus {
  return CHECK_SNAPSHOT_STATUSES.has(value as CheckIssueSnapshotStatus);
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

export function isLiminaCheckIssueSeverity(
  value: unknown,
): value is LiminaCheckIssueSeverity {
  return ISSUE_SEVERITIES.has(value as LiminaCheckIssueSeverity);
}

export function isLiminaCheckRunResult(
  value: unknown,
): value is LiminaCheckRunResult {
  return RUN_RESULTS.has(value as LiminaCheckRunResult);
}

export function isLiminaCheckRunTaskKind(
  value: unknown,
): value is LiminaCheckRunTaskKind {
  return TASK_KINDS.has(value as LiminaCheckRunTaskKind);
}

export function isLiminaCheckRunCheckItemStatus(
  value: unknown,
): value is LiminaCheckRunCheckItemStatus {
  return CHECK_ITEM_STATUSES.has(value as LiminaCheckRunCheckItemStatus);
}

export function isLiminaCheckRunTaskStatus(
  value: unknown,
): value is LiminaCheckRunTaskStatus {
  return TASK_STATUSES.has(value as LiminaCheckRunTaskStatus);
}

export function isKnownIssueTask(value: string): value is LiminaCheckTaskName {
  return ISSUE_TASKS.has(value);
}

export function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isOptionalFiniteNonNegativeNumber(value: unknown): boolean {
  return value === undefined || isFiniteNonNegativeNumber(value);
}

export function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isOptionalRecord<T>(
  value: unknown,
  isPredicate: (entry: unknown) => entry is T,
): boolean {
  return value === undefined || isPredicate(value);
}

export function isOptionalArray<T>(
  value: unknown,
  isPredicate: (entry: unknown) => entry is T,
): boolean {
  return (
    value === undefined || (Array.isArray(value) && value.every(isPredicate))
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value);
}
