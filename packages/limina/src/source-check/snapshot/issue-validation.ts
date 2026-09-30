import {
  assertIssueTaskMatchesCode,
  assertWritableLiminaCheckIssueCode,
  getLiminaCheckIssueRuleMetadata,
  isReadableLiminaCheckIssueCode,
  type LiminaReadableCheckIssueCode,
} from '../../check-reporting/codes';
import { isLiminaCheckRunSummary } from './run-validation';
import type {
  CanonicalLiminaCheckIssue,
  CheckIssueSnapshot,
  LiminaCheckIssue,
  LiminaCheckIssueEvidence,
  LiminaCheckIssueExternal,
  LiminaCheckIssueLocation,
  SourceIssueSnapshot,
  SourceIssueSnapshotIssue,
} from './types';
import {
  CHECK_ISSUE_SNAPSHOT_VERSION,
  SOURCE_ISSUE_SNAPSHOT_VERSION,
} from './types';
import {
  isAllValid,
  isCheckIssueSnapshotStatus,
  isKnownIssueTask,
  isLiminaCheckIssueSeverity,
  isOptionalArray,
  isOptionalString,
  isOptionalStringArray,
  isRecord,
  isSourceIssueSnapshotStatus,
} from './validation-shared';

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}

function isOptionalSeverity(value: unknown): boolean {
  return value === undefined || isLiminaCheckIssueSeverity(value);
}

function isOptionalExternal(value: unknown): boolean {
  return value === undefined || isLiminaCheckIssueExternal(value);
}

function isLiminaCheckIssueLocation(
  value: unknown,
): value is LiminaCheckIssueLocation {
  if (!isRecord(value)) return false;
  return isAllValid([
    isOptionalString(value.label),
    isOptionalString(value.filePath),
    isOptionalString(value.packageManifestPath),
    isOptionalString(value.scope),
    isOptionalNumber(value.line),
    isOptionalNumber(value.column),
  ]);
}

function isLiminaCheckIssueEvidence(
  value: unknown,
): value is LiminaCheckIssueEvidence {
  if (!isRecord(value)) return false;
  return isAllValid([
    isOptionalString(value.label),
    isOptionalString(value.value),
    isOptionalStringArray(value.lines),
  ]);
}

function isLiminaCheckIssueExternal(
  value: unknown,
): value is LiminaCheckIssueExternal {
  return (
    isRecord(value) &&
    [value.tool, value.code, value.message, value.url].every(isOptionalString)
  );
}

function isSourceIssueSnapshotIssue(
  value: unknown,
): value is SourceIssueSnapshotIssue {
  if (!isRecord(value)) return false;
  return isAllValid([
    typeof value.code === 'string',
    isOptionalString(value.ownerName),
    isOptionalString(value.filePath),
  ]);
}

function hasSourceSnapshotIssues(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.issues) &&
    value.issues.every(isSourceIssueSnapshotIssue)
  );
}

export function isSourceIssueSnapshot(
  value: unknown,
): value is SourceIssueSnapshot {
  if (!isRecord(value)) return false;
  return isAllValid([
    value.version === SOURCE_ISSUE_SNAPSHOT_VERSION,
    typeof value.command === 'string',
    typeof value.createdAt === 'string',
    isSourceIssueSnapshotStatus(value.status),
    hasSourceSnapshotIssues(value),
  ]);
}

function hasKnownIssueTask(value: Record<string, unknown>): boolean {
  return typeof value.task === 'string' && isKnownIssueTask(value.task);
}

function hasReadableIssueCode(value: Record<string, unknown>): boolean {
  return (
    typeof value.code === 'string' && isReadableLiminaCheckIssueCode(value.code)
  );
}

function getReadableIssueCode(
  value: unknown,
): LiminaReadableCheckIssueCode | null {
  return typeof value !== 'string' || !isReadableLiminaCheckIssueCode(value)
    ? null
    : value;
}

function hasMatchingIssueTask(value: Record<string, unknown>): boolean {
  const code = getReadableIssueCode(value.code);
  return (
    code !== null &&
    typeof value.task === 'string' &&
    getLiminaCheckIssueRuleMetadata(code).task === value.task
  );
}

function hasLiminaCheckIssueBaseFields(
  value: Record<string, unknown>,
): boolean {
  return isAllValid([
    hasKnownIssueTask(value),
    hasReadableIssueCode(value),
    hasMatchingIssueTask(value),
    typeof value.title === 'string',
    typeof value.reason === 'string',
  ]);
}

function hasLiminaCheckIssueStructuredFields(
  value: Record<string, unknown>,
): boolean {
  return isAllValid([
    isOptionalString(value.id),
    isOptionalString(value.domain),
    isOptionalString(value.detector),
    isOptionalString(value.summary),
    isOptionalSeverity(value.severity),
    isOptionalStringArray(value.fixSteps),
    isOptionalStringArray(value.verifyCommands),
    isOptionalArray(value.locations, isLiminaCheckIssueLocation),
    isOptionalArray(value.evidence, isLiminaCheckIssueEvidence),
    isOptionalExternal(value.external),
  ]);
}

function hasLiminaCheckIssuePresentationFields(
  value: Record<string, unknown>,
): boolean {
  return isAllValid([
    isOptionalStringArray(value.detailLines),
    isOptionalString(value.fix),
    isOptionalString(value.packageManifestPath),
    isOptionalString(value.packageName),
    isOptionalString(value.filePath),
    isOptionalString(value.scope),
    isOptionalString(value.checkerName),
    isOptionalString(value.tool),
  ]);
}

export function isLiminaCheckIssue(value: unknown): value is LiminaCheckIssue {
  if (!isRecord(value)) return false;
  return isAllValid([
    hasLiminaCheckIssueBaseFields(value),
    hasLiminaCheckIssueStructuredFields(value),
    hasLiminaCheckIssuePresentationFields(value),
  ]);
}

export function assertWritableLiminaCheckIssue(
  issue: LiminaCheckIssue,
): asserts issue is CanonicalLiminaCheckIssue {
  assertWritableLiminaCheckIssueCode(issue.code);
  assertIssueTaskMatchesCode(issue.code, issue.task);
}

function hasCheckSnapshotIssues(value: Record<string, unknown>): boolean {
  return Array.isArray(value.issues) && value.issues.every(isLiminaCheckIssue);
}

function hasOptionalRun(value: Record<string, unknown>): boolean {
  return value.run === undefined || isLiminaCheckRunSummary(value.run);
}

export function isCurrentCheckIssueSnapshotStructure(
  value: unknown,
): value is CheckIssueSnapshot {
  if (!isRecord(value)) return false;
  return isAllValid([
    value.version === CHECK_ISSUE_SNAPSHOT_VERSION,
    typeof value.command === 'string',
    typeof value.createdAt === 'string',
    isCheckIssueSnapshotStatus(value.status),
    hasCheckSnapshotIssues(value),
    hasOptionalRun(value),
  ]);
}

function getSnapshotCommand(snapshot: CheckIssueSnapshot): string {
  return snapshot.run === undefined ? snapshot.command : snapshot.run.command;
}

export function isCheckInventoryOwner(snapshot: CheckIssueSnapshot): boolean {
  return (
    snapshot.status === 'not-run' ||
    /^limina check(?:\s|$)/u.test(getSnapshotCommand(snapshot))
  );
}
