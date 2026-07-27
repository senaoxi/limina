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
  allValid,
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
  if (value === undefined) return true;
  return typeof value === 'number';
}

function isOptionalSeverity(value: unknown): boolean {
  if (value === undefined) return true;
  return isLiminaCheckIssueSeverity(value);
}

function isOptionalExternal(value: unknown): boolean {
  if (value === undefined) return true;
  return isLiminaCheckIssueExternal(value);
}

function isLiminaCheckIssueLocation(
  value: unknown,
): value is LiminaCheckIssueLocation {
  if (!isRecord(value)) return false;
  return allValid([
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
  return allValid([
    isOptionalString(value.label),
    isOptionalString(value.value),
    isOptionalStringArray(value.lines),
  ]);
}

function isLiminaCheckIssueExternal(
  value: unknown,
): value is LiminaCheckIssueExternal {
  if (!isRecord(value)) return false;
  return [value.tool, value.code, value.message, value.url].every(
    isOptionalString,
  );
}

function isSourceIssueSnapshotIssue(
  value: unknown,
): value is SourceIssueSnapshotIssue {
  if (!isRecord(value)) return false;
  return allValid([
    typeof value.code === 'string',
    typeof value.ownerName === 'string',
    isOptionalString(value.filePath),
  ]);
}

function hasSourceSnapshotIssues(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.issues)) return false;
  return value.issues.every(isSourceIssueSnapshotIssue);
}

export function isSourceIssueSnapshot(
  value: unknown,
): value is SourceIssueSnapshot {
  if (!isRecord(value)) return false;
  return allValid([
    value.version === SOURCE_ISSUE_SNAPSHOT_VERSION,
    typeof value.command === 'string',
    typeof value.createdAt === 'string',
    isSourceIssueSnapshotStatus(value.status),
    hasSourceSnapshotIssues(value),
  ]);
}

function hasKnownIssueTask(value: Record<string, unknown>): boolean {
  if (typeof value.task !== 'string') return false;
  return isKnownIssueTask(value.task);
}

function hasReadableIssueCode(value: Record<string, unknown>): boolean {
  if (typeof value.code !== 'string') return false;
  return isReadableLiminaCheckIssueCode(value.code);
}

function getReadableIssueCode(
  value: unknown,
): LiminaReadableCheckIssueCode | null {
  if (typeof value !== 'string') return null;
  if (!isReadableLiminaCheckIssueCode(value)) return null;
  return value;
}

function hasMatchingIssueTask(value: Record<string, unknown>): boolean {
  const code = getReadableIssueCode(value.code);
  if (code === null) return false;
  if (typeof value.task !== 'string') return false;
  return getLiminaCheckIssueRuleMetadata(code).task === value.task;
}

function hasLiminaCheckIssueBaseFields(
  value: Record<string, unknown>,
): boolean {
  return allValid([
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
  return allValid([
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
  return allValid([
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
  return allValid([
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
  if (!Array.isArray(value.issues)) return false;
  return value.issues.every(isLiminaCheckIssue);
}

function hasOptionalRun(value: Record<string, unknown>): boolean {
  if (value.run === undefined) return true;
  return isLiminaCheckRunSummary(value.run);
}

export function isCurrentCheckIssueSnapshotStructure(
  value: unknown,
): value is CheckIssueSnapshot {
  if (!isRecord(value)) return false;
  return allValid([
    value.version === CHECK_ISSUE_SNAPSHOT_VERSION,
    typeof value.command === 'string',
    typeof value.createdAt === 'string',
    isCheckIssueSnapshotStatus(value.status),
    hasCheckSnapshotIssues(value),
    hasOptionalRun(value),
  ]);
}

function getSnapshotCommand(snapshot: CheckIssueSnapshot): string {
  if (snapshot.run === undefined) return snapshot.command;
  return snapshot.run.command;
}

export function isCheckInventoryOwner(snapshot: CheckIssueSnapshot): boolean {
  if (snapshot.status === 'not-run') return true;
  return /^limina check(?:\s|$)/u.test(getSnapshotCommand(snapshot));
}
