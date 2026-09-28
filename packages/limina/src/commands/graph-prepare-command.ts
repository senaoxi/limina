import type { ResolvedLiminaConfig } from '#config/runner';
import { createElapsedTimer } from 'logaria/helper';
import { LiminaStructuredError } from '../check-reporting/errors';
import {
  completeCheckIssueSnapshot,
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import {
  runGraphPrepareImpl,
  type RunGraphPrepareOptions,
} from '../graph-check/runner';
import { formatErrorMessage, GraphLogger } from '../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import {
  createGraphCommandTask,
  failGraphTask,
  type GraphCommandTask,
  isGraphInteractiveFlow,
  isGraphReportDeferred,
  isGraphSnapshotDeferred,
  logGraphIssueReport,
  passGraphTask,
  persistGraphIssues,
  prepareGraphCommand,
} from './graph-command-shared';

export interface GraphPrepareCommandContext {
  config: ResolvedLiminaConfig;
  elapsed: ReturnType<typeof createElapsedTimer>;
  options: RunGraphPrepareOptions;
  preflight: LiminaPreflightManager;
  task: GraphCommandTask | undefined;
}

export function createGraphPrepareCommandContext(
  config: ResolvedLiminaConfig,
  options: RunGraphPrepareOptions,
): GraphPrepareCommandContext {
  prepareGraphCommand(options);
  GraphLogger.info('graph prepare started');

  return {
    config,
    elapsed: createElapsedTimer(),
    options,
    preflight: resolvePreflight(config, options),
    task: createGraphCommandTask(options, 'graph prepare'),
  };
}

function getPrepareSuccessMessage(changed: boolean): string {
  return changed
    ? 'graph prepare generated files'
    : 'graph prepare found generated files up to date';
}

function logPrepareSuccess(
  context: GraphPrepareCommandContext,
  changed: boolean,
): void {
  if (!isGraphInteractiveFlow(context.options)) {
    GraphLogger.success(getPrepareSuccessMessage(changed), context.elapsed());
  }
}

async function completePrepareSnapshot(
  context: GraphPrepareCommandContext,
): Promise<void> {
  if (isGraphSnapshotDeferred(context.options)) {
    return;
  }

  await completeCheckIssueSnapshot({
    artifactNamespace: context.preflight.artifactNamespace,
    rootDir: context.config.rootDir,
  });
}

export async function executeGraphPrepareCommand(
  context: GraphPrepareCommandContext,
): Promise<true> {
  const result = await runGraphPrepareImpl(context.config, {
    ...context.options,
    preflight: context.preflight,
  });

  logPrepareSuccess(context, result.changed);
  passGraphTask(context.task);
  await completePrepareSnapshot(context);
  return true;
}

function createPrepareFailureIssue(
  context: GraphPrepareCommandContext,
  error: unknown,
): LiminaCheckIssue {
  return createTaskFailureIssue({
    code: 'LIMINA_GRAPH_PREPARE_FAILED',
    filePath: context.config.configPath,
    fix: 'Inspect the graph prepare error above, then rerun `limina graph prepare` or `limina check`.',
    reason: `Graph prepare failed: ${formatErrorMessage(error)}.`,
    rootDir: context.config.rootDir,
    task: 'graph:prepare',
    title: 'Graph prepare failed',
  });
}

function getPrepareFailureIssues(
  context: GraphPrepareCommandContext,
  error: unknown,
): readonly LiminaCheckIssue[] {
  return error instanceof LiminaStructuredError
    ? error.issues
    : [createPrepareFailureIssue(context, error)];
}

function shouldLogStructuredReport(
  context: GraphPrepareCommandContext,
  error: unknown,
): boolean {
  return [
    !isGraphReportDeferred(context.options),
    error instanceof LiminaStructuredError,
  ].every(Boolean);
}

function logStructuredPrepareReport(
  context: GraphPrepareCommandContext,
  error: unknown,
  issues: readonly LiminaCheckIssue[],
): void {
  if (shouldLogStructuredReport(context, error)) {
    logGraphIssueReport({
      command: 'limina graph prepare',
      commandOptions: context.options,
      issues,
      title: 'Graph prepare summary',
    });
  }
}

function isReportVerbose(options: RunGraphPrepareOptions): boolean {
  const report = options.report;
  return report === undefined ? false : report.verbose === true;
}

function shouldShowRawPrepareError(
  options: RunGraphPrepareOptions,
  error: unknown,
): boolean {
  return [
    !(error instanceof LiminaStructuredError),
    isReportVerbose(options),
  ].some(Boolean);
}

function logPrepareFailure(
  context: GraphPrepareCommandContext,
  error: unknown,
): boolean {
  const showRawError = shouldShowRawPrepareError(context.options, error);
  const message = showRawError
    ? `graph prepare failed: ${formatErrorMessage(error)}`
    : 'graph prepare failed';

  GraphLogger.error(message, context.elapsed());
  return showRawError;
}

function failPrepareTask(
  context: GraphPrepareCommandContext,
  error: unknown,
  showRawError: boolean,
): void {
  const details = showRawError ? { error } : undefined;
  failGraphTask(context.task, 'graph prepare failed', details);
}

export async function handleGraphPrepareCommandError(
  context: GraphPrepareCommandContext,
  error: unknown,
): Promise<never> {
  const issues = getPrepareFailureIssues(context, error);
  await persistGraphIssues({
    artifactNamespace: context.preflight.artifactNamespace,
    commandOptions: context.options,
    issues,
    rootDir: context.config.rootDir,
  });
  logStructuredPrepareReport(context, error, issues);
  const showRawError = logPrepareFailure(context, error);
  failPrepareTask(context, error, showRawError);
  throw error;
}
