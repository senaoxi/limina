import { createElapsedTimer } from 'logaria/helper';
import { LiminaStructuredError } from '../check-reporting/errors';
import {
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import { formatErrorMessage, TypecheckLogger } from '../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import {
  runCheckerTypecheckImpl,
  type RunCheckerTypecheckOptions,
  type RunCheckerTypecheckResult,
} from '../typecheck/runner';
import { createCheckerFailureIssues } from './checker-failure-issues';
import {
  collectCheckIssues,
  completeCheckSnapshotIfNeeded,
  createTypecheckTask,
  type DeferredCheckIssueOptions,
  disableTypecheckTask,
  failTypecheckTask,
  getTypecheckReportCommand,
  initializeTypecheckCommand,
  logCheckerIssueReport,
  passTypecheckTask,
  shouldLogTypecheckSuccess,
  type TypecheckCommandTask,
} from './typecheck-command-shared';

type CheckerTypecheckCommandOptions = RunCheckerTypecheckOptions &
  DeferredCheckIssueOptions;

interface CheckerTypecheckContext {
  elapsed: ReturnType<typeof createElapsedTimer>;
  options: CheckerTypecheckCommandOptions;
  preflight: LiminaPreflightManager;
  task: TypecheckCommandTask | undefined;
}

function createCheckerTypecheckContext(
  options: CheckerTypecheckCommandOptions,
): CheckerTypecheckContext {
  initializeTypecheckCommand({
    label: 'checker typecheck',
    lifecycle: options,
  });
  return {
    elapsed: createElapsedTimer(),
    options,
    preflight: resolvePreflight(options.config, options),
    task: createTypecheckTask({
      label: 'checker typecheck',
      lifecycle: options,
      suppressForProgress: true,
    }),
  };
}

async function persistIssues(
  context: CheckerTypecheckContext,
  issues: readonly LiminaCheckIssue[],
): Promise<void> {
  await collectCheckIssues({
    artifactNamespace: context.preflight.artifactNamespace,
    deferSnapshot: context.options.deferSnapshot,
    issueSink: context.options.issues,
    issues,
    rootDir: context.options.config.rootDir,
  });
}

function reportIssues(
  context: CheckerTypecheckContext,
  issues: readonly LiminaCheckIssue[],
): void {
  logCheckerIssueReport({
    command: getTypecheckReportCommand(
      context.options,
      'limina checker typecheck',
    ),
    elapsed: context.elapsed(),
    issues,
    lifecycle: context.options,
    title: 'Checker typecheck summary',
  });
}

async function handlePassedTypecheck(
  context: CheckerTypecheckContext,
  result: RunCheckerTypecheckResult,
): Promise<RunCheckerTypecheckResult> {
  await completeCheckSnapshotIfNeeded({
    artifactNamespace: context.preflight.artifactNamespace,
    deferSnapshot: context.options.deferSnapshot,
    rootDir: context.options.config.rootDir,
  });

  if (shouldLogTypecheckSuccess(context.options)) {
    TypecheckLogger.success('checker typecheck finished', context.elapsed());
  }

  passTypecheckTask(context.task);
  return result;
}

function handleDisabledTypecheck(
  context: CheckerTypecheckContext,
  result: RunCheckerTypecheckResult,
): RunCheckerTypecheckResult {
  disableTypecheckTask(context.task);
  return result;
}

function createResultFailureIssues(
  context: CheckerTypecheckContext,
  result: RunCheckerTypecheckResult,
): LiminaCheckIssue[] {
  return createCheckerFailureIssues({
    failedTargets: result.failedTargets,
    fallbackCheckerNames: result.checkerNames,
    fallbackFilePath: context.options.config.configPath,
    fallbackReason: 'Checker typecheck finished with failures.',
    failureKind: result.failureKind,
    fix: 'Inspect the checker typecheck output above, then rerun `limina checker typecheck` or `limina check`.',
    projectRootDir: result.projectRootDir,
    problems: result.problems,
    task: 'checker:typecheck',
    title: 'Checker typecheck failed',
  });
}

async function handleFailedTypecheck(
  context: CheckerTypecheckContext,
  result: RunCheckerTypecheckResult,
): Promise<RunCheckerTypecheckResult> {
  const issues = createResultFailureIssues(context, result);
  await persistIssues(context, issues);
  reportIssues(context, issues);
  failTypecheckTask({
    reason: 'checker typecheck finished with failures',
    task: context.task,
  });
  return result;
}

function createUnexpectedTypecheckIssue(
  context: CheckerTypecheckContext,
  error: unknown,
): LiminaCheckIssue {
  const errorMessage = formatErrorMessage(error);
  return createTaskFailureIssue({
    code: 'LIMINA_CHECKER_TYPECHECK_FAILED',
    detailLines: [errorMessage],
    filePath: context.options.config.configPath,
    fix: 'Inspect the checker typecheck error above, then rerun `limina checker typecheck` or `limina check`.',
    reason: `Checker typecheck failed: ${errorMessage}.`,
    rootDir: context.options.config.rootDir,
    task: 'checker:typecheck',
    title: 'Checker typecheck failed',
  });
}

function getErrorIssues(
  context: CheckerTypecheckContext,
  error: unknown,
): readonly LiminaCheckIssue[] {
  return error instanceof LiminaStructuredError
    ? error.issues
    : [createUnexpectedTypecheckIssue(context, error)];
}

async function handleTypecheckError(
  context: CheckerTypecheckContext,
  error: unknown,
): Promise<never> {
  const issues = getErrorIssues(context, error);
  await persistIssues(context, issues);
  reportIssues(context, issues);
  failTypecheckTask({
    details: error instanceof LiminaStructuredError ? undefined : { error },
    reason: 'checker typecheck failed',
    task: context.task,
  });
  throw error;
}

function handleTypecheckResult(
  context: CheckerTypecheckContext,
  result: RunCheckerTypecheckResult,
): Promise<RunCheckerTypecheckResult> {
  if (result.disabled) {
    return Promise.resolve(handleDisabledTypecheck(context, result));
  }
  return result.passed
    ? handlePassedTypecheck(context, result)
    : handleFailedTypecheck(context, result);
}

export async function runCheckerTypecheck(
  options: CheckerTypecheckCommandOptions,
): Promise<RunCheckerTypecheckResult> {
  const context = createCheckerTypecheckContext(options);

  try {
    const result = await runCheckerTypecheckImpl({
      ...options,
      preflight: context.preflight,
    });
    return handleTypecheckResult(context, result);
  } catch (error) {
    return handleTypecheckError(context, error);
  }
}
