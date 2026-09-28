import { createElapsedTimer } from 'logaria/helper';
import { LiminaStructuredError } from '../check-reporting/errors';
import {
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import { formatErrorMessage, TypecheckLogger } from '../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import {
  runCheckerBuildImpl,
  type RunCheckerBuildOptions,
  type RunCheckerBuildResult,
} from '../typecheck/runner';
import {
  createCheckerFailureIssues,
  getCheckerFailureFilePath,
} from './checker-failure-issues';
import {
  collectCheckIssues,
  completeCheckSnapshotIfNeeded,
  createTypecheckTask,
  type DeferredCheckIssueOptions,
  failTypecheckTask,
  getTypecheckReportCommand,
  initializeTypecheckCommand,
  isTypecheckReportDeferred,
  logCheckerIssueReport,
  passTypecheckTask,
  shouldLogTypecheckSuccess,
  type TypecheckCommandTask,
} from './typecheck-command-shared';

type CheckerBuildCommandOptions = RunCheckerBuildOptions &
  DeferredCheckIssueOptions;

interface CheckerBuildContext {
  elapsed: ReturnType<typeof createElapsedTimer>;
  options: CheckerBuildCommandOptions;
  preflight: LiminaPreflightManager;
  task: TypecheckCommandTask | undefined;
}

function createCheckerBuildContext(
  options: CheckerBuildCommandOptions,
): CheckerBuildContext {
  initializeTypecheckCommand({ label: 'checker build', lifecycle: options });
  return {
    elapsed: createElapsedTimer(),
    options,
    preflight: resolvePreflight(options.config, options),
    task: createTypecheckTask({
      label: 'checker build',
      lifecycle: options,
      suppressForProgress: true,
    }),
  };
}

async function persistIssues(
  context: CheckerBuildContext,
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
  context: CheckerBuildContext,
  issues: readonly LiminaCheckIssue[],
): void {
  logCheckerIssueReport({
    command: getTypecheckReportCommand(context.options, 'limina checker build'),
    elapsed: context.elapsed(),
    issues,
    lifecycle: context.options,
    title: 'Checker build summary',
  });
}

async function handlePassedBuild(
  context: CheckerBuildContext,
  result: RunCheckerBuildResult,
): Promise<RunCheckerBuildResult> {
  await completeCheckSnapshotIfNeeded({
    artifactNamespace: context.preflight.artifactNamespace,
    deferSnapshot: context.options.deferSnapshot,
    rootDir: context.options.config.rootDir,
  });

  if (shouldLogTypecheckSuccess(context.options)) {
    TypecheckLogger.success('checker build finished', context.elapsed());
  }

  passTypecheckTask(context.task);
  return result;
}

function createResultFailureIssues(
  context: CheckerBuildContext,
  result: RunCheckerBuildResult,
): LiminaCheckIssue[] {
  return createCheckerFailureIssues({
    failedTargets: result.failedTargets,
    fallbackFilePath: getCheckerFailureFilePath(context.options),
    fallbackReason: 'Checker build finished with failures.',
    failureKind: result.failureKind,
    fix: 'Inspect the checker build output above, then rerun `limina checker build` or `limina check`.',
    hideExecutionDetails: isTypecheckReportDeferred(context.options),
    projectRootDir: result.projectRootDir,
    problems: result.problems,
    task: 'checker:build',
    title: 'Checker build failed',
  });
}

async function handleFailedBuild(
  context: CheckerBuildContext,
  result: RunCheckerBuildResult,
): Promise<RunCheckerBuildResult> {
  const issues = createResultFailureIssues(context, result);
  await persistIssues(context, issues);
  reportIssues(context, issues);
  failTypecheckTask({
    reason: 'checker build finished with failures',
    task: context.task,
  });
  return result;
}

function getUnexpectedBuildIssuePresentation(
  deferred: boolean,
  errorMessage: string,
): {
  detailLines?: string[];
  reason: string;
  summary?: string;
} {
  if (deferred) {
    return {
      reason: 'Checker build failed.',
      summary: 'Checker build failed',
    };
  }

  return {
    detailLines: [errorMessage],
    reason: `Checker build failed: ${errorMessage}.`,
  };
}

function createUnexpectedBuildIssue(
  context: CheckerBuildContext,
  error: unknown,
): LiminaCheckIssue {
  const errorMessage = formatErrorMessage(error);
  const presentation = getUnexpectedBuildIssuePresentation(
    isTypecheckReportDeferred(context.options),
    errorMessage,
  );
  return createTaskFailureIssue({
    code: 'LIMINA_CHECKER_BUILD_FAILED',
    ...presentation,
    filePath: getCheckerFailureFilePath(context.options),
    fix: 'Inspect the checker build error above, then rerun `limina checker build` or `limina check`.',
    rootDir: context.options.config.rootDir,
    task: 'checker:build',
    title: 'Checker build failed',
  });
}

function getErrorIssues(
  context: CheckerBuildContext,
  error: unknown,
): readonly LiminaCheckIssue[] {
  return error instanceof LiminaStructuredError
    ? error.issues
    : [createUnexpectedBuildIssue(context, error)];
}

async function handleBuildError(
  context: CheckerBuildContext,
  error: unknown,
): Promise<never> {
  const issues = getErrorIssues(context, error);
  await persistIssues(context, issues);
  reportIssues(context, issues);
  failTypecheckTask({
    details: error instanceof LiminaStructuredError ? undefined : { error },
    reason: 'checker build failed',
    task: context.task,
  });
  throw error;
}

export async function runCheckerBuild(
  options: CheckerBuildCommandOptions,
): Promise<RunCheckerBuildResult> {
  const context = createCheckerBuildContext(options);

  try {
    const result = await runCheckerBuildImpl({
      ...options,
      preflight: context.preflight,
    });
    return result.passed
      ? handlePassedBuild(context, result)
      : handleFailedBuild(context, result);
  } catch (error) {
    return handleBuildError(context, error);
  }
}
