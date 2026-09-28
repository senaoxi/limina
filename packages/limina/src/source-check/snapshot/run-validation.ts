import type {
  CheckerTargetCheckItemSnapshot,
  LiminaCheckRunBlockedBy,
  LiminaCheckRunCheckItemSummary,
  LiminaCheckRunSummary,
  LiminaCheckRunTaskSummary,
} from './types';
import {
  allValid,
  CHECKER_TARGET_ID_PATTERN,
  hasOnlyKeys,
  isFiniteNonNegativeNumber,
  isKnownIssueTask,
  isLiminaCheckRunCheckItemStatus,
  isLiminaCheckRunResult,
  isLiminaCheckRunTaskKind,
  isLiminaCheckRunTaskStatus,
  isNonEmptyString,
  isOptionalArray,
  isOptionalFiniteNonNegativeNumber,
  isOptionalRecord,
  isOptionalString,
  isRecord,
} from './validation-shared';

const CHECK_ITEM_STATISTIC_KEYS = [
  'checksPassed',
  'checksTotal',
  'durationMs',
  'issues',
  'itemKind',
  'name',
  'status',
] as const;

const TASK_KEYS = [
  'blockedBy',
  'checkItems',
  'checksPassed',
  'checksTotal',
  'completedAt',
  'durationMs',
  'generation',
  'id',
  'issueTask',
  'kind',
  'label',
  'reason',
  'startedAt',
  'state',
] as const;

const RUN_KEYS = [
  'blockedBy',
  'command',
  'completedAt',
  'configPath',
  'createdAt',
  'durationMs',
  'pipeline',
  'result',
  'startedAt',
  'tasks',
] as const;

export function isLiminaCheckRunBlockedBy(
  value: unknown,
): value is LiminaCheckRunBlockedBy {
  if (!isRecord(value)) return false;
  return allValid([
    hasOnlyKeys(value, ['id', 'label']),
    isNonEmptyString(value.id),
    isNonEmptyString(value.label),
  ]);
}

function hasValidCheckItemStatistics(value: Record<string, unknown>): boolean {
  return allValid([
    isNonEmptyString(value.name),
    isLiminaCheckRunCheckItemStatus(value.status),
    isOptionalFiniteNonNegativeNumber(value.checksPassed),
    isOptionalFiniteNonNegativeNumber(value.checksTotal),
    isOptionalFiniteNonNegativeNumber(value.durationMs),
    isOptionalFiniteNonNegativeNumber(value.issues),
  ]);
}

function isCheckerTargetBlocker(value: unknown): value is {
  id: string;
  name: string;
} {
  if (!isRecord(value)) return false;
  const validId =
    typeof value.id === 'string' && CHECKER_TARGET_ID_PATTERN.test(value.id);
  return allValid([
    hasOnlyKeys(value, ['id', 'name']),
    isNonEmptyString(value.name),
    validId,
  ]);
}

function hasBlockedTargetEntries(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return allValid([value.length > 0, value.every(isCheckerTargetBlocker)]);
}

function hasValidCheckerTargetBlockers(
  value: Record<string, unknown>,
): boolean {
  if (value.status !== 'blocked') return value.blockedBy === undefined;
  return hasBlockedTargetEntries(value.blockedBy);
}

function isValidationCheckItem(value: Record<string, unknown>): boolean {
  if (value.itemKind !== 'check') return false;
  return hasOnlyKeys(value, CHECK_ITEM_STATISTIC_KEYS);
}

function hasCheckerTargetId(value: Record<string, unknown>): boolean {
  if (typeof value.id !== 'string') return false;
  return CHECKER_TARGET_ID_PATTERN.test(value.id);
}

function isCheckerTargetCheckItem(
  value: Record<string, unknown>,
): value is Record<string, unknown> & CheckerTargetCheckItemSnapshot {
  if (value.itemKind !== 'checker-target') return false;
  return allValid([
    hasOnlyKeys(value, [...CHECK_ITEM_STATISTIC_KEYS, 'blockedBy', 'id']),
    hasCheckerTargetId(value),
    hasValidCheckerTargetBlockers(value),
  ]);
}

function isSupportedCheckItem(value: Record<string, unknown>): boolean {
  if (isValidationCheckItem(value)) return true;
  return isCheckerTargetCheckItem(value);
}

export function isLiminaCheckRunCheckItemSummary(
  value: unknown,
): value is LiminaCheckRunCheckItemSummary {
  if (!isRecord(value)) return false;
  if (!hasValidCheckItemStatistics(value)) return false;
  return isSupportedCheckItem(value);
}

function hasKnownTask(value: Record<string, unknown>): boolean {
  if (typeof value.issueTask !== 'string') return false;
  return isKnownIssueTask(value.issueTask);
}

function hasValidTaskIdentity(value: Record<string, unknown>): boolean {
  return allValid([
    isNonEmptyString(value.id),
    isNonEmptyString(value.label),
    hasKnownTask(value),
    isLiminaCheckRunTaskKind(value.kind),
    isLiminaCheckRunTaskStatus(value.state),
  ]);
}

function hasValidTaskGeneration(value: Record<string, unknown>): boolean {
  if (!Number.isInteger(value.generation)) return false;
  return (value.generation as number) >= 0;
}

function hasValidTaskTiming(value: Record<string, unknown>): boolean {
  return [value.startedAt, value.completedAt, value.reason].every(
    isOptionalString,
  );
}

function hasValidTaskStatistics(value: Record<string, unknown>): boolean {
  return [value.checksPassed, value.checksTotal, value.durationMs].every(
    isOptionalFiniteNonNegativeNumber,
  );
}

export function isLiminaCheckRunTaskSummary(
  value: unknown,
): value is LiminaCheckRunTaskSummary {
  if (!isRecord(value)) return false;
  return allValid([
    hasOnlyKeys(value, TASK_KEYS),
    hasValidTaskIdentity(value),
    hasValidTaskGeneration(value),
    hasValidTaskTiming(value),
    hasValidTaskStatistics(value),
    isOptionalArray(value.checkItems, isLiminaCheckRunCheckItemSummary),
    isOptionalRecord(value.blockedBy, isLiminaCheckRunBlockedBy),
  ]);
}

function hasValidRunIdentity(value: Record<string, unknown>): boolean {
  return allValid([
    typeof value.command === 'string',
    typeof value.createdAt === 'string',
    isLiminaCheckRunResult(value.result),
  ]);
}

function hasValidRunTiming(value: Record<string, unknown>): boolean {
  return allValid([
    isOptionalString(value.startedAt),
    isOptionalString(value.completedAt),
    isOptionalFiniteNonNegativeNumber(value.durationMs),
  ]);
}

function hasValidRunMetadata(value: Record<string, unknown>): boolean {
  return allValid([
    isOptionalString(value.configPath),
    isOptionalString(value.pipeline),
  ]);
}

function hasValidRunTasks(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.tasks)) return false;
  return value.tasks.every(isLiminaCheckRunTaskSummary);
}

export function isLiminaCheckRunSummary(
  value: unknown,
): value is LiminaCheckRunSummary {
  if (!isRecord(value)) return false;
  return allValid([
    hasOnlyKeys(value, RUN_KEYS),
    hasValidRunIdentity(value),
    hasValidRunTasks(value),
    hasValidRunTiming(value),
    hasValidRunMetadata(value),
    isOptionalRecord(value.blockedBy, isLiminaCheckRunBlockedBy),
  ]);
}

export function isValidCompletedDuration(value: unknown): value is number {
  return isFiniteNonNegativeNumber(value);
}
