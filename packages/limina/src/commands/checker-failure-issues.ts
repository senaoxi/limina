import path from 'pathe';
import {
  LIMINA_CHECK_ISSUE_CODES,
  type LiminaWritableCheckIssueCode,
} from '../check-reporting/codes';
import {
  createTaskFailureIssue,
  type LiminaCheckIssue,
  type LiminaCheckTaskName,
} from '../check-reporting/snapshot';
import type {
  CheckerFailureKind,
  CheckerFailureTarget,
} from '../typecheck/runner';

export interface CheckerFailureIssueOptions {
  failedTargets: readonly CheckerFailureTarget[];
  fallbackFilePath?: string;
  fallbackReason: string;
  failureKind?: CheckerFailureKind;
  fix: string;
  hideExecutionDetails?: boolean;
  projectRootDir: string;
  problems?: readonly string[];
  task: Extract<LiminaCheckTaskName, 'checker:build' | 'checker:typecheck'>;
  title: string;
}

export function getCheckerFailureFilePath(options: {
  config: { configPath: string };
  configPath?: string;
  cwd?: string;
}): string {
  if (options.configPath === undefined) {
    return options.config.configPath;
  }

  return path.resolve(options.cwd ?? process.cwd(), options.configPath);
}

function getDefaultFailureCode(
  task: CheckerFailureIssueOptions['task'],
): LiminaWritableCheckIssueCode {
  return task === 'checker:build'
    ? LIMINA_CHECK_ISSUE_CODES.checkerBuildFailed
    : LIMINA_CHECK_ISSUE_CODES.checkerTypecheckFailed;
}

function isPeerDependencyBuildFailure(
  options: CheckerFailureIssueOptions,
): boolean {
  return (
    options.failureKind === 'peer-dependency' &&
    options.task === 'checker:build'
  );
}

function getFailureCode(
  options: CheckerFailureIssueOptions,
): LiminaWritableCheckIssueCode {
  if (isPeerDependencyBuildFailure(options)) {
    return LIMINA_CHECK_ISSUE_CODES.checkerPeerDependencyMissing;
  }

  if (options.failureKind === 'target-selection') {
    return LIMINA_CHECK_ISSUE_CODES.checkerTargetSelectionFailed;
  }

  return getDefaultFailureCode(options.task);
}

function getVerifyCommand(task: CheckerFailureIssueOptions['task']): string {
  return task === 'checker:build'
    ? 'limina checker build'
    : 'limina checker typecheck';
}

function getVisibleProblems(
  options: CheckerFailureIssueOptions,
): readonly string[] | undefined {
  return options.hideExecutionDetails === true ? undefined : options.problems;
}

function createProblemEvidence(
  problems: readonly string[] | undefined,
): LiminaCheckIssue['evidence'] {
  if (problems === undefined || problems.length === 0) {
    return undefined;
  }

  return [{ label: 'checker diagnostic', lines: [...problems] }];
}

function createFallbackFailureIssue(
  options: CheckerFailureIssueOptions,
): LiminaCheckIssue {
  const problems = getVisibleProblems(options);
  return createTaskFailureIssue({
    code: getFailureCode(options),
    detailLines: problems,
    evidence: createProblemEvidence(problems),
    filePath: options.fallbackFilePath,
    fix: options.fix,
    fixSteps: [options.fix],
    reason:
      options.hideExecutionDetails === true
        ? options.title
        : options.fallbackReason,
    rootDir: options.projectRootDir,
    summary: options.hideExecutionDetails === true ? options.title : undefined,
    task: options.task,
    title: options.title,
    verifyCommands: [getVerifyCommand(options.task)],
  });
}

function getTargetMessage(
  target: CheckerFailureTarget,
  hideExecutionDetails: boolean | undefined,
): string | undefined {
  return hideExecutionDetails === true ? undefined : target.message;
}

function createTargetReason(
  target: CheckerFailureTarget,
  message: string | undefined,
): string {
  const checkerReason =
    target.checkerName === undefined
      ? 'Checker target failed.'
      : `Checker "${target.checkerName}" failed.`;
  const reasons = [checkerReason, `Exit code: ${target.exitCode}.`];

  if (message !== undefined) {
    reasons.push(`Error: ${message}.`);
  }

  return reasons.join(' ');
}

function createTargetEvidence(
  target: CheckerFailureTarget,
  message: string | undefined,
): LiminaCheckIssue['evidence'] {
  const evidence: NonNullable<LiminaCheckIssue['evidence']> = [
    { label: 'exit code', value: String(target.exitCode) },
  ];

  if (message !== undefined) {
    evidence.push({ label: 'error', value: message });
  }

  return evidence;
}

function createTargetFailureIssue(
  target: CheckerFailureTarget,
  options: CheckerFailureIssueOptions,
): LiminaCheckIssue {
  const message = getTargetMessage(target, options.hideExecutionDetails);
  return createTaskFailureIssue({
    checkerName: target.checkerName,
    code: getDefaultFailureCode(options.task),
    evidence: createTargetEvidence(target, message),
    filePath: target.configPath,
    fix: options.fix,
    fixSteps: [options.fix],
    reason: createTargetReason(target, message),
    rootDir: options.projectRootDir,
    summary: options.hideExecutionDetails === true ? options.title : undefined,
    task: options.task,
    title: options.title,
    verifyCommands: [getVerifyCommand(options.task)],
  });
}

export function createCheckerFailureIssues(
  options: CheckerFailureIssueOptions,
): LiminaCheckIssue[] {
  if (options.failedTargets.length === 0) {
    return [createFallbackFailureIssue(options)];
  }

  return options.failedTargets.map((target) =>
    createTargetFailureIssue(target, options),
  );
}
