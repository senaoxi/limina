import { createElapsedTimer } from 'logaria/helper';
import { LiminaStructuredError } from '../check-reporting/errors';
import {
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import { formatErrorMessage, TypecheckLogger } from '../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import {
  runBuildImpl,
  type RunBuildOptions,
  type RunBuildResult,
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
  logCheckerIssueReport,
  passTypecheckTask,
  shouldLogTypecheckSuccess,
  type TypecheckCommandTask,
} from './typecheck-command-shared';

type BuildCommandOptions = RunBuildOptions & DeferredCheckIssueOptions;

interface BuildCommandContext {
  elapsed: ReturnType<typeof createElapsedTimer>;
  options: BuildCommandOptions;
  preflight: LiminaPreflightManager;
  task: TypecheckCommandTask | undefined;
}

function createBuildContext(options: BuildCommandOptions): BuildCommandContext {
  initializeTypecheckCommand({ label: 'build', lifecycle: options });
  return {
    elapsed: createElapsedTimer(),
    options,
    preflight: resolvePreflight(options.config, options),
    task: createTypecheckTask({
      label: 'build',
      lifecycle: options,
      suppressForProgress: false,
    }),
  };
}

async function persistIssues(
  context: BuildCommandContext,
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
  context: BuildCommandContext,
  issues: readonly LiminaCheckIssue[],
): void {
  logCheckerIssueReport({
    command: getTypecheckReportCommand(context.options, 'limina checker build'),
    elapsed: context.elapsed(),
    issues,
    lifecycle: context.options,
    title: 'Build summary',
  });
}

async function handlePassedBuild(
  context: BuildCommandContext,
  result: RunBuildResult,
): Promise<RunBuildResult> {
  await completeCheckSnapshotIfNeeded({
    artifactNamespace: context.preflight.artifactNamespace,
    deferSnapshot: context.options.deferSnapshot,
    rootDir: context.options.config.rootDir,
  });

  if (shouldLogTypecheckSuccess(context.options)) {
    TypecheckLogger.success('build finished', context.elapsed());
  }

  passTypecheckTask(context.task);
  return result;
}

function createResultFailureIssues(
  context: BuildCommandContext,
  result: RunBuildResult,
): LiminaCheckIssue[] {
  return createCheckerFailureIssues({
    failedTargets: result.failedTargets,
    fallbackFilePath: getCheckerFailureFilePath(context.options),
    fallbackReason: 'Checker build finished with failures.',
    failureKind: result.failureKind,
    fix: 'Inspect the build output above, then rerun `limina build <config>`.',
    projectRootDir: result.projectRootDir,
    problems: result.problems,
    task: 'checker:build',
    title: 'Checker build failed',
  });
}

async function handleFailedBuild(
  context: BuildCommandContext,
  result: RunBuildResult,
): Promise<RunBuildResult> {
  const issues = createResultFailureIssues(context, result);
  await persistIssues(context, issues);
  reportIssues(context, issues);
  failTypecheckTask({
    reason: 'build finished with failures',
    task: context.task,
  });
  return result;
}

function createUnexpectedBuildIssue(
  context: BuildCommandContext,
  error: unknown,
): LiminaCheckIssue {
  const errorMessage = formatErrorMessage(error);
  return createTaskFailureIssue({
    code: 'LIMINA_CHECKER_BUILD_FAILED',
    detailLines: [errorMessage],
    filePath: getCheckerFailureFilePath(context.options),
    fix: 'Inspect the build error above, then rerun `limina build <config>`.',
    reason: `Checker build failed: ${errorMessage}.`,
    rootDir: context.options.config.rootDir,
    task: 'checker:build',
    title: 'Checker build failed',
  });
}

function getErrorIssues(
  context: BuildCommandContext,
  error: unknown,
): readonly LiminaCheckIssue[] {
  return error instanceof LiminaStructuredError
    ? error.issues
    : [createUnexpectedBuildIssue(context, error)];
}

async function handleBuildError(
  context: BuildCommandContext,
  error: unknown,
): Promise<never> {
  const issues = getErrorIssues(context, error);
  await persistIssues(context, issues);
  reportIssues(context, issues);
  failTypecheckTask({
    details: error instanceof LiminaStructuredError ? undefined : { error },
    reason: 'build failed',
    task: context.task,
  });
  throw error;
}

export async function runBuild(
  options: BuildCommandOptions,
): Promise<RunBuildResult> {
  const context = createBuildContext(options);

  try {
    const result = await runBuildImpl({
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
