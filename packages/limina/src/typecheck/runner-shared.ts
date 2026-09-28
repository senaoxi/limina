import { toRelativePath } from '#utils/path';
import { shouldUseColor } from '#utils/reporting';
import type { CheckIssueReportOptions } from '../check-reporting/human';
import type {
  TaskProgressItem,
  TaskProgressReporter,
} from '../execution/progress';
import type { LiminaFlowReporter, LiminaFlowTask } from '../flow';
import { formatErrorMessage, TypecheckLogger } from '../logger';
import { formatCheckIssueSummaryReport } from '../reporting';
import type { CheckerFailureTarget } from './runner-types';
import {
  type CheckerTargetId,
  createDefaultRunner,
  type TypecheckRunner,
  type TypecheckTarget,
  type TypecheckTargetResult,
} from './targets';

type CheckerFlowTask = LiminaFlowTask | TaskProgressItem;

export function getCheckerTargetFlowLabel(options: {
  prefix: string;
  projectRootDir: string;
  target: TypecheckTarget;
}): string {
  if (options.target.label !== undefined) return options.target.label;
  return `${options.prefix}: ${toRelativePath(
    options.projectRootDir,
    options.target.configPath,
  )}`;
}

export function createPlannedCheckerTargetTasks(options: {
  prefix: string;
  progress: TaskProgressReporter | undefined;
  projectRootDir: string;
  targets: readonly TypecheckTarget[];
}): Map<CheckerTargetId, TaskProgressItem> {
  const tasks = new Map<CheckerTargetId, TaskProgressItem>();
  if (options.progress === undefined) return tasks;
  for (const target of options.targets) {
    tasks.set(
      target.id,
      options.progress.planItem(
        getCheckerTargetFlowLabel({ ...options, target }),
      ),
    );
  }
  return tasks;
}

export function formatTypecheckProblemSummaryReport(options: {
  pluralIssueLabel: string;
  problems: readonly string[];
  singularIssueLabel: string;
  title: string;
}): string {
  return formatCheckIssueSummaryReport({
    color: shouldUseColor(),
    details: options.problems.join('\n\n'),
    issueCount: options.problems.length,
    pluralIssueLabel: options.pluralIssueLabel,
    singularIssueLabel: options.singularIssueLabel,
    title: options.title,
  });
}

export function shouldLogCheckReport(
  report: CheckIssueReportOptions | undefined,
): boolean {
  return report?.defer !== true;
}

function reportDegradedRunner(options: {
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  reason: string;
}): void {
  const message = `checker duration measurement degraded: ${options.reason}`;
  if (options.flow === undefined) {
    TypecheckLogger.warn(message);
    return;
  }
  options.flow.warn(message, {
    depth: (options.flowDepth ?? 0) + 1,
    persistInteractive: true,
  });
}

function getRunnerStdio(
  report: CheckIssueReportOptions | undefined,
): 'ignore' | 'inherit' {
  return report?.defer === true ? 'ignore' : 'inherit';
}

export function resolveTypecheckRunner(options: {
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  report?: CheckIssueReportOptions;
  runner?: TypecheckRunner;
}): TypecheckRunner {
  if (options.runner !== undefined) return options.runner;
  return createDefaultRunner({
    onDegraded: (reason) => reportDegradedRunner({ ...options, reason }),
    stdio: getRunnerStdio(options.report),
  });
}

function getElapsedOptions(
  result: TypecheckTargetResult,
): { elapsedTimeMs: number } | undefined {
  if (result.durationMs === undefined) return undefined;
  return { elapsedTimeMs: result.durationMs };
}

function getFailureSuffix(result: TypecheckTargetResult): string {
  if (result.error !== undefined) return formatErrorMessage(result.error);
  return `exited with code ${result.status}`;
}

export function completeCheckerTargetTask(
  task: CheckerFlowTask,
  result: TypecheckTargetResult,
): void {
  const elapsedOptions = getElapsedOptions(result);
  if (result.blockedBy !== undefined) {
    task.skip(`blocked by ${result.blockedBy.join(', ')}`, elapsedOptions);
    return;
  }
  if (result.status === 0) {
    task.pass(undefined, elapsedOptions);
    return;
  }
  task.fail(undefined, {
    ...elapsedOptions,
    error: getFailureSuffix(result),
  });
}

function formatFailedResult(options: {
  projectRootDir: string;
  result: TypecheckTargetResult;
}): string {
  const path = toRelativePath(
    options.projectRootDir,
    options.result.configPath,
  );
  if (options.result.blockedBy !== undefined) {
    return `  ${path} blocked by ${options.result.blockedBy.join(', ')}`;
  }
  if (options.result.error !== undefined) {
    return `  ${path}: ${formatErrorMessage(options.result.error)}`;
  }
  return `  ${path} exited with code ${options.result.status}`;
}

export function formatFailedTargetSummaryReport(options: {
  failedResults: readonly TypecheckTargetResult[];
  heading: string;
  pluralIssueLabel: string;
  projectRootDir: string;
  singularIssueLabel: string;
  title: string;
}): string {
  return formatCheckIssueSummaryReport({
    color: shouldUseColor(),
    details: [
      options.heading,
      ...options.failedResults.map((result) =>
        formatFailedResult({ projectRootDir: options.projectRootDir, result }),
      ),
    ].join('\n'),
    issueCount: options.failedResults.length,
    pluralIssueLabel: options.pluralIssueLabel,
    singularIssueLabel: options.singularIssueLabel,
    title: options.title,
  });
}

function createFailureTarget(options: {
  target: TypecheckTarget | undefined;
  result: TypecheckTargetResult;
}): CheckerFailureTarget {
  return {
    blockedByTarget: options.result.blockedBy,
    checkerName: options.target?.checkerName,
    configPath: options.result.configPath,
    exitCode: options.result.status,
    id: options.result.id,
    message:
      options.result.error === undefined
        ? undefined
        : formatErrorMessage(options.result.error),
  };
}

export function collectFailedCheckerTargets(
  targets: readonly TypecheckTarget[],
  results: readonly TypecheckTargetResult[],
): CheckerFailureTarget[] {
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  return results
    .filter((result) => result.status !== 0)
    .map((result) =>
      createFailureTarget({
        result,
        target: targetsById.get(result.id),
      }),
    );
}
