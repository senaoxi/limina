import {
  LIMINA_CHECK_ISSUE_CODES,
  type LiminaCheckIssueCode,
} from './issue-code-values';
import {
  LIMINA_CHECK_ISSUE_RULE_METADATA,
  type LiminaCheckIssueRuleMetadata,
  type LiminaCheckIssueRuleStatus,
} from './rules/metadata';
import type { LiminaCheckTaskName } from './snapshot';

export {
  LIMINA_CHECK_ISSUE_CODES,
  type LiminaCheckIssueCode,
} from './issue-code-values';
export type {
  LiminaCheckIssueRuleMetadata,
  LiminaCheckIssueRuleStatus,
} from './rules/metadata';

export type LiminaReadableCheckIssueCode = Exclude<
  LiminaCheckIssueCode,
  typeof LIMINA_CHECK_ISSUE_CODES.releaseConsistency
>;

export type LiminaWritableCheckIssueCode = Exclude<
  LiminaCheckIssueCode,
  | typeof LIMINA_CHECK_ISSUE_CODES.pipelineCommandFailed
  | typeof LIMINA_CHECK_ISSUE_CODES.releaseConsistency
>;

const LIMINA_CHECK_ISSUE_CODE_VALUES: readonly LiminaCheckIssueCode[] =
  Object.values(LIMINA_CHECK_ISSUE_CODES);

const LIMINA_CHECK_ISSUE_CODE_SET: ReadonlySet<string> = new Set(
  LIMINA_CHECK_ISSUE_CODE_VALUES,
);

export function isLiminaCheckIssueCode(
  code: string,
): code is LiminaCheckIssueCode {
  return LIMINA_CHECK_ISSUE_CODE_SET.has(code);
}

export function listLiminaCheckIssueCodes(): readonly LiminaCheckIssueCode[] {
  return [...LIMINA_CHECK_ISSUE_CODE_VALUES].sort();
}

function getIssueRuleStatus(
  code: LiminaCheckIssueCode,
): LiminaCheckIssueRuleStatus {
  return LIMINA_CHECK_ISSUE_RULE_METADATA[code].status;
}

export function isWritableLiminaCheckIssueCode(
  code: string,
): code is LiminaWritableCheckIssueCode {
  return isLiminaCheckIssueCode(code) && getIssueRuleStatus(code) === 'active';
}

export function isReadableLiminaCheckIssueCode(
  code: string,
): code is LiminaReadableCheckIssueCode {
  return isLiminaCheckIssueCode(code) && getIssueRuleStatus(code) !== 'planned';
}

export function getLiminaCheckIssueRuleMetadata(
  code: LiminaCheckIssueCode,
): LiminaCheckIssueRuleMetadata {
  return { ...LIMINA_CHECK_ISSUE_RULE_METADATA[code] };
}

function compareRuleMetadata(
  left: LiminaCheckIssueRuleMetadata,
  right: LiminaCheckIssueRuleMetadata,
): number {
  const taskComparison = left.task.localeCompare(right.task);
  return taskComparison === 0
    ? left.code.localeCompare(right.code)
    : taskComparison;
}

export function listLiminaCheckIssueRuleMetadata(): readonly LiminaCheckIssueRuleMetadata[] {
  return LIMINA_CHECK_ISSUE_CODE_VALUES.map(
    getLiminaCheckIssueRuleMetadata,
  ).sort(compareRuleMetadata);
}

export function assertIssueTaskMatchesCode(
  code: LiminaCheckIssueCode,
  task: LiminaCheckTaskName,
): void {
  const expectedTask = getLiminaCheckIssueRuleMetadata(code).task;

  if (task !== expectedTask) {
    throw new Error(
      `Issue code ${code} belongs to ${expectedTask}, not ${task}.`,
    );
  }
}

function assertKnownIssueCode(
  code: string,
): asserts code is LiminaCheckIssueCode {
  if (!isLiminaCheckIssueCode(code)) {
    throw new Error(`Unknown canonical Limina issue code: ${code}.`);
  }
}

function assertActiveIssueCode(code: LiminaCheckIssueCode): void {
  const status = getIssueRuleStatus(code);
  const errorMessages: Partial<Record<LiminaCheckIssueRuleStatus, string>> = {
    planned: `Planned Limina issue code is not writable: ${code}.`,
    retired: `Retired Limina issue code is read-only: ${code}.`,
  };
  const errorMessage = errorMessages[status];

  if (errorMessage !== undefined) {
    throw new Error(errorMessage);
  }
}

export function assertWritableLiminaCheckIssueCode(
  code: string,
): asserts code is LiminaWritableCheckIssueCode {
  assertKnownIssueCode(code);
  assertActiveIssueCode(code);
}

export const DEFAULT_ISSUE_CODE_BY_TASK: Readonly<
  Record<LiminaCheckTaskName, LiminaWritableCheckIssueCode>
> = {
  'checker:build': LIMINA_CHECK_ISSUE_CODES.checkerBuildFailed,
  'checker:typecheck': LIMINA_CHECK_ISSUE_CODES.checkerTypecheckFailed,
  command: LIMINA_CHECK_ISSUE_CODES.commandFailed,
  'graph:check': LIMINA_CHECK_ISSUE_CODES.graphCheckFailed,
  'graph:materialize': LIMINA_CHECK_ISSUE_CODES.graphMaterializeFailed,
  'graph:prepare': LIMINA_CHECK_ISSUE_CODES.graphPrepareFailed,
  'package:check': LIMINA_CHECK_ISSUE_CODES.packageCheckFailed,
  'proof:check': LIMINA_CHECK_ISSUE_CODES.proofCheckFailed,
  'release:check': LIMINA_CHECK_ISSUE_CODES.releaseCheckFailed,
  'source:check': LIMINA_CHECK_ISSUE_CODES.sourceCheckFailed,
  'workspace:validate': LIMINA_CHECK_ISSUE_CODES.workspaceValidationFailed,
};

export function defaultTaskFailureCode(
  task: LiminaCheckTaskName,
): LiminaWritableCheckIssueCode {
  return DEFAULT_ISSUE_CODE_BY_TASK[task];
}
