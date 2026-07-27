import type { ResolvedLiminaConfig } from '#config/runner';
import { createElapsedTimer } from 'logaria/helper';
import { LiminaStructuredError } from '../check-reporting/errors';
import {
  completeCheckIssueSnapshot,
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import {
  runGraphCheckImpl,
  type RunGraphCheckOptions,
} from '../graph-check/runner';
import { formatErrorMessage, GraphLogger } from '../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import {
  createGraphCommandTask,
  failGraphTask,
  type GraphCommandTask,
  isGraphReportDeferred,
  isGraphSnapshotDeferred,
  logGraphIssueReport,
  passGraphTask,
  persistGraphIssues,
  prepareGraphCommand,
  shouldLogGraphSuccess,
} from './graph-command-shared';

export interface GraphCheckCommandContext {
  config: ResolvedLiminaConfig;
  elapsed: ReturnType<typeof createElapsedTimer>;
  options: RunGraphCheckOptions;
  preflight: LiminaPreflightManager;
  task: GraphCommandTask | undefined;
}

function shouldLogCheckStart(options: RunGraphCheckOptions): boolean {
  return options.flow === undefined;
}

export function createGraphCheckCommandContext(
  config: ResolvedLiminaConfig,
  options: RunGraphCheckOptions,
): GraphCheckCommandContext {
  prepareGraphCommand(options);

  if (shouldLogCheckStart(options)) {
    GraphLogger.info('graph check started');
  }

  return {
    config,
    elapsed: createElapsedTimer(),
    options,
    preflight: resolvePreflight(config, options),
    task: createGraphCommandTask(options, 'graph check'),
  };
}

function createGraphCheckErrorIssue(
  config: ResolvedLiminaConfig,
  errorMessage: string,
): LiminaCheckIssue {
  return createTaskFailureIssue({
    code: 'LIMINA_GRAPH_CHECK_FAILED',
    detailLines: errorMessage.split('\n'),
    filePath: config.configPath,
    fix: 'Inspect the graph check error above, then rerun `limina graph check` or `limina check`.',
    reason: `Graph check failed: ${errorMessage}.`,
    rootDir: config.rootDir,
    task: 'graph:check',
    title: 'Graph check failed',
  });
}

function createUnstructuredCheckIssue(
  config: ResolvedLiminaConfig,
): LiminaCheckIssue {
  return createTaskFailureIssue({
    code: 'LIMINA_GRAPH_CHECK_FAILED',
    filePath: config.configPath,
    fix: 'Inspect the graph check report above, update the source/config/package boundary, then rerun `limina graph check` or `limina check`.',
    reason:
      'Graph check found architecture, dependency, or resolver violations.',
    rootDir: config.rootDir,
    task: 'graph:check',
    title: 'Graph check failed',
  });
}

function selectCheckIssues(
  issues: readonly LiminaCheckIssue[],
  config: ResolvedLiminaConfig,
): readonly LiminaCheckIssue[] {
  return issues.length > 0 ? issues : [createUnstructuredCheckIssue(config)];
}

async function completeCheckSnapshot(
  context: GraphCheckCommandContext,
): Promise<void> {
  if (isGraphSnapshotDeferred(context.options)) {
    return;
  }

  await completeCheckIssueSnapshot({
    artifactNamespace: context.preflight.artifactNamespace,
    rootDir: context.config.rootDir,
  });
}

async function handlePassedGraphCheck(
  context: GraphCheckCommandContext,
): Promise<true> {
  await completeCheckSnapshot(context);

  if (shouldLogGraphSuccess(context.options)) {
    GraphLogger.success('graph check finished', context.elapsed());
  }

  passGraphTask(context.task);
  return true;
}

function shouldLogFailedCheck(options: RunGraphCheckOptions): boolean {
  return options.flow === undefined;
}

async function handleFailedGraphCheck(
  context: GraphCheckCommandContext,
  issues: readonly LiminaCheckIssue[],
): Promise<false> {
  const reportIssues = selectCheckIssues(issues, context.config);
  await persistGraphIssues({
    artifactNamespace: context.preflight.artifactNamespace,
    commandOptions: context.options,
    issues: reportIssues,
    rootDir: context.config.rootDir,
  });

  if (shouldLogFailedCheck(context.options)) {
    GraphLogger.error('graph check finished with failures', context.elapsed());
  }

  failGraphTask(context.task, 'graph check finished with failures');
  return false;
}

export async function executeGraphCheckCommand(
  context: GraphCheckCommandContext,
): Promise<boolean> {
  const issues: LiminaCheckIssue[] = [];
  const passed = await runGraphCheckImpl(context.config, {
    generatedGraphProvider: context.options.generatedGraphProvider,
    issues,
    logSuccess: shouldLogGraphSuccess(context.options),
    onStats: context.options.onStats,
    preflight: context.preflight,
    progress: context.options.progress,
    providers: context.options.providers,
    report: context.options.report,
  });

  return passed
    ? handlePassedGraphCheck(context)
    : handleFailedGraphCheck(context, issues);
}

function getCheckErrorIssues(
  context: GraphCheckCommandContext,
  error: unknown,
): readonly LiminaCheckIssue[] {
  return error instanceof LiminaStructuredError
    ? error.issues
    : [createGraphCheckErrorIssue(context.config, formatErrorMessage(error))];
}

function shouldReturnCheckFailure(options: RunGraphCheckOptions): boolean {
  return options.flow !== undefined;
}

export async function handleGraphCheckCommandError(
  context: GraphCheckCommandContext,
  error: unknown,
): Promise<false> {
  const issues = getCheckErrorIssues(context, error);
  await persistGraphIssues({
    artifactNamespace: context.preflight.artifactNamespace,
    commandOptions: context.options,
    issues,
    rootDir: context.config.rootDir,
  });

  if (!isGraphReportDeferred(context.options)) {
    logGraphIssueReport({
      command: 'limina graph check',
      commandOptions: context.options,
      issues,
      title: 'Graph check summary',
    });
  }

  failGraphTask(context.task, 'graph check failed');

  if (shouldReturnCheckFailure(context.options)) {
    return false;
  }

  throw error;
}
