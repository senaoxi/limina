import { toRelativePath } from '#utils/path';
import { shouldUseColor } from '#utils/reporting';
import type { CheckIssueReportOptions } from '../check-reporting/human';
import { formatShellCommand } from '../check-reporting/shell-command';
import type {
  TaskProgressItem,
  TaskProgressReporter,
} from '../execution/progress';
import type { LiminaFlowReporter, LiminaFlowTask } from '../flow';
import { formatErrorMessage, TypecheckLogger } from '../logger';
import { formatCheckIssueSummaryReport } from '../reporting';
import type { CheckerFailureTarget } from './runner-types';
import {
  type BuildTargetCompletion,
  type CheckerTargetId,
  createDefaultRunner,
  runTargetWithMeasuredDuration,
  type TypecheckRunner,
  type TypecheckTarget,
  type TypecheckTargetResult,
} from './targets';

function getCheckerTargetFlowLabel(options: {
  prefix: string;
  nested: boolean;
  projectRootDir: string;
  target: TypecheckTarget;
}): string {
  const { nested, prefix, projectRootDir, target } = options;
  if (
    target.label !== undefined &&
    (!nested || target.checkerFamily !== undefined)
  )
    return target.label;
  const path = toRelativePath(
    projectRootDir,
    target.sourceConfigPath ?? target.configPath,
  );
  return `${target.checkerName ?? prefix}: ${path}`;
}

function observeTargetProgress<T>(observe: () => T): T | undefined {
  try {
    return observe();
  } catch {
    // A Flow observer cannot change the outcome of an execution boundary.
    return undefined;
  }
}

interface CheckerTargetFlow {
  complete: (
    target: TypecheckTarget,
    result: BuildTargetCompletion,
    hasDeliveryFailed?: boolean,
  ) => void;
  progress: (target: TypecheckTarget) => TaskProgressReporter | undefined;
  start: (target: TypecheckTarget) => void;
}

export function createCheckerTargetFlow(options: {
  flow: LiminaFlowReporter | undefined;
  flowDepth: number;
  prefix: string;
  progress: TaskProgressReporter | undefined;
  projectRootDir: string;
  targets: readonly TypecheckTarget[];
}): CheckerTargetFlow {
  const planned = new Map<CheckerTargetId, TaskProgressItem>();
  const standalone = new Map<CheckerTargetId, LiminaFlowTask>();
  const { flow, progress } = options;
  const label = (target: TypecheckTarget) =>
    getCheckerTargetFlowLabel({
      ...options,
      nested: progress !== undefined,
      target,
    });
  if (progress !== undefined) {
    for (const target of options.targets) {
      const item = observeTargetProgress(() =>
        progress.planItem(label(target)),
      );
      if (item !== undefined) planned.set(target.id, item);
    }
  }
  return {
    start(target: TypecheckTarget): void {
      if (progress !== undefined) {
        observeTargetProgress(() => planned.get(target.id)?.start());
      } else if (flow !== undefined) {
        standalone.set(
          target.id,
          flow.start(label(target), {
            collapseOnSuccess: false,
            depth: options.flowDepth + 1,
          }),
        );
      }
    },
    progress: (target: TypecheckTarget) => planned.get(target.id)?.progress,
    complete(
      target: TypecheckTarget,
      result: BuildTargetCompletion,
      hasDeliveryFailed = false,
    ): void {
      const item = planned.get(target.id);
      if (item !== undefined) {
        observeTargetProgress(() => {
          if (result.status === 'blocked') {
            const reason =
              result.blockedBy.length === 0
                ? 'blocked: prerequisite checker failed'
                : `blocked by ${result.blockedBy.join(', ')}`;
            item.skip(`${label(target)} (${reason})`);
          } else if (!hasDeliveryFailed && result.status === 0) {
            item.pass();
          } else {
            item.fail();
          }
        });
        return;
      }
      const task = standalone.get(target.id);
      if (task === undefined) return;
      if (typeof result.status === 'number') {
        completeCheckerTargetTask(task, result);
      } else {
        task.fail();
      }
    },
  };
}

type FinishCheckerTargetAdmission = (
  status: 'pass' | 'fail',
  finishedAt?: number,
) => void;

export function startCheckerTargetAdmission(
  progress: TaskProgressReporter | undefined,
): FinishCheckerTargetAdmission | undefined {
  const item = observeTargetProgress(() =>
    progress?.planItem('admit checker target execution'),
  );
  if (item === undefined) return undefined;
  observeTargetProgress(() => item.start());
  const startedAt = performance.now();
  return (status, finishedAt = performance.now()) => {
    observeTargetProgress(() =>
      item[status](undefined, { elapsedTimeMs: finishedAt - startedAt }),
    );
  };
}

export async function runCheckerTargetProcess(options: {
  finishAdmission: FinishCheckerTargetAdmission | undefined;
  progress: TaskProgressReporter | undefined;
  runner: TypecheckRunner;
  signal?: AbortSignal;
  target: TypecheckTarget;
}): Promise<TypecheckTargetResult> {
  const { finishAdmission, progress, runner, signal, target } = options;
  if (progress === undefined)
    return runTargetWithMeasuredDuration(runner, target, signal);

  const isCancelledBeforeRequest = signal?.aborted === true;
  const startedAt = performance.now();
  const pending = runTargetWithMeasuredDuration(runner, target, signal);
  // Enter the runner before any renderer can reenter after the launch permit.
  finishAdmission?.('pass', startedAt);
  if (isCancelledBeforeRequest) return pending;

  const hasTypeScriptCommandOverride =
    target.checkerName === 'tsc' && target.args[0] === '-b';
  const configuredLabel =
    !hasTypeScriptCommandOverride && target.checkerFamily === undefined
      ? target.label
      : undefined;
  const command =
    configuredLabel ?? formatShellCommand([target.command, ...target.args]);
  const item = observeTargetProgress(() => progress.planItem(command));
  if (item === undefined) return pending;
  observeTargetProgress(() => item.start());

  let result: TypecheckTargetResult;
  try {
    result = await pending;
  } catch (error) {
    const elapsedTimeMs = performance.now() - startedAt;
    observeTargetProgress(() =>
      item.fail(`${command} (runner request)`, { elapsedTimeMs, error }),
    );
    throw error;
  }
  const commandDurationMs = result.commandDurationMs;
  const hasCommandDuration =
    commandDurationMs !== undefined &&
    Number.isFinite(commandDurationMs) &&
    commandDurationMs >= 0;
  const elapsedTimeMs = hasCommandDuration
    ? commandDurationMs
    : Number.isFinite(result.durationMs) && result.durationMs >= 0
      ? result.durationMs
      : performance.now() - startedAt;
  observeTargetProgress(() =>
    completeCheckerTargetTask(
      item,
      result,
      { elapsedTimeMs },
      hasCommandDuration ? undefined : `${command} (runner request)`,
    ),
  );
  return result;
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
  return result.durationMs === undefined
    ? undefined
    : { elapsedTimeMs: result.durationMs };
}

function getFailureSuffix(result: TypecheckTargetResult): string {
  return result.error === undefined
    ? `exited with code ${result.status}`
    : formatErrorMessage(result.error);
}

export function completeCheckerTargetTask(
  task: LiminaFlowTask | TaskProgressItem,
  result: TypecheckTargetResult,
  elapsedOptions: ReturnType<typeof getElapsedOptions> = getElapsedOptions(
    result,
  ),
  name?: string,
): void {
  if (result.blockedBy !== undefined) {
    task.skip(`blocked by ${result.blockedBy.join(', ')}`, elapsedOptions);
    return;
  }
  if (result.status === 0) {
    task.pass(name, elapsedOptions);
    return;
  }
  task.fail(name, {
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
    options.result.sourceConfigPath ?? options.result.configPath,
  );
  if (options.result.blockedBy !== undefined) {
    return `  ${path} blocked by ${options.result.blockedBy.join(', ')}`;
  }
  return options.result.error === undefined
    ? `  ${path} exited with code ${options.result.status}`
    : `  ${path}: ${formatErrorMessage(options.result.error)}`;
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
    configPath: options.result.sourceConfigPath ?? options.result.configPath,
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
