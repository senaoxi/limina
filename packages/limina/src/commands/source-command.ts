import type { ResolvedLiminaConfig } from '#config/runner';
import { createElapsedTimer } from 'logaria/helper';
import { LiminaStructuredError } from '../check-reporting/errors';
import { clearCliScreen, formatErrorMessage, SourceLogger } from '../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import {
  runSourceCheckImpl,
  type RunSourceCheckOptions,
} from '../source-check/runner';
import {
  type CanonicalLiminaCheckIssue,
  createSourceCheckIssue,
  createTaskFailureIssue,
  type LiminaCheckIssue,
  writeNotRunSourceIssueSnapshot,
} from '../source-check/snapshot';

interface SourceCommandTask {
  fail(reason: string): void;
  pass(): void;
}

interface SourceCommandContext {
  config: ResolvedLiminaConfig;
  elapsed: ReturnType<typeof createElapsedTimer>;
  options: RunSourceCheckOptions;
  preflight: LiminaPreflightManager;
  task: SourceCommandTask | undefined;
}

function getReportCommand(options: RunSourceCheckOptions): string | undefined {
  const report = options.report;
  return report === undefined ? undefined : report.command;
}

function getSourceCommandName(options: RunSourceCheckOptions): string {
  const command = getReportCommand(options);
  return command === undefined ? 'limina source check' : command;
}

function isSnapshotDeferred(options: RunSourceCheckOptions): boolean {
  return options.deferSnapshot === true;
}

async function writeInitialSnapshot(
  config: ResolvedLiminaConfig,
  options: RunSourceCheckOptions,
  preflight: LiminaPreflightManager,
): Promise<void> {
  if (isSnapshotDeferred(options)) {
    return;
  }

  await writeNotRunSourceIssueSnapshot({
    artifactNamespace: preflight.artifactNamespace,
    command: getSourceCommandName(options),
    rootDir: config.rootDir,
  });
}

function hasProgress(options: RunSourceCheckOptions): boolean {
  return options.progress !== undefined;
}

function getFlowDepth(options: RunSourceCheckOptions): number {
  return options.flowDepth === undefined ? 0 : options.flowDepth;
}

function createSourceTask(
  options: RunSourceCheckOptions,
): SourceCommandTask | undefined {
  if (hasProgress(options)) {
    return undefined;
  }

  const flow = options.flow;
  return flow === undefined
    ? undefined
    : flow.start('source check', { depth: getFlowDepth(options) });
}

function logSourceStart(options: RunSourceCheckOptions): void {
  if (!options.flow) {
    SourceLogger.info('source check started');
  }
}

export async function createSourceCommandContext(
  config: ResolvedLiminaConfig,
  options: RunSourceCheckOptions,
): Promise<SourceCommandContext> {
  const preflight = resolvePreflight(config, options);
  await writeInitialSnapshot(config, options, preflight);

  if (shouldClearScreen(options)) {
    clearCliScreen();
  }

  const context: SourceCommandContext = {
    config,
    elapsed: createElapsedTimer(),
    options,
    preflight,
    task: createSourceTask(options),
  };
  logSourceStart(options);
  return context;
}

function shouldClearScreen(options: RunSourceCheckOptions): boolean {
  return options.clearScreen === undefined ? true : options.clearScreen;
}

function isReportDeferred(options: RunSourceCheckOptions): boolean {
  const report = options.report;
  return report !== undefined && report.defer === true;
}

function isInteractiveFlow(options: RunSourceCheckOptions): boolean {
  const flow = options.flow;
  return flow !== undefined && flow.interactive === true;
}

function shouldLogSuccess(options: RunSourceCheckOptions): boolean {
  return [!isReportDeferred(options), !isInteractiveFlow(options)].every(
    Boolean,
  );
}

async function executeSourceCheckImpl(
  context: SourceCommandContext,
  sourceIssues: NonNullable<RunSourceCheckOptions['sourceIssues']>,
): Promise<boolean> {
  const { options } = context;

  return runSourceCheckImpl(context.config, {
    deferSnapshot: options.deferSnapshot,
    generatedGraphProvider: options.generatedGraphProvider,
    knipRunner: options.knipRunner,
    logSuccess: shouldLogSuccess(options),
    onStats: options.onStats,
    onSourceSnapshot: options.onSourceSnapshot,
    preflight: context.preflight,
    progress: options.progress,
    providers: options.providers,
    report: options.report,
    sourceIssues,
  });
}

function createUnstructuredFailureIssue(
  config: ResolvedLiminaConfig,
): CanonicalLiminaCheckIssue {
  return createTaskFailureIssue({
    code: 'LIMINA_SOURCE_CHECK_FAILED',
    filePath: config.configPath,
    fix: 'Inspect the source check report above, then rerun `limina source check` or `limina check`.',
    reason: 'Source check finished without structured issue details.',
    rootDir: config.rootDir,
    task: 'source:check',
    title: 'Source check failed',
  });
}

function createFailedSourceIssues(
  config: ResolvedLiminaConfig,
  sourceIssues: NonNullable<RunSourceCheckOptions['sourceIssues']>,
): CanonicalLiminaCheckIssue[] {
  return sourceIssues.length > 0
    ? sourceIssues.map((issue) =>
        createSourceCheckIssue({ issue, rootDir: config.rootDir }),
      )
    : [createUnstructuredFailureIssue(config)];
}

function appendIssues(
  target: LiminaCheckIssue[] | undefined,
  issues: readonly LiminaCheckIssue[],
): void {
  if (target !== undefined) {
    target.push(...issues);
  }
}

function recordDeferredIssues(
  options: RunSourceCheckOptions,
  issues: readonly LiminaCheckIssue[],
): void {
  if (isSnapshotDeferred(options)) {
    appendIssues(options.issues, issues);
  }
}

function shouldLogFailedResult(options: RunSourceCheckOptions): boolean {
  return [!isReportDeferred(options), options.flow === undefined].every(
    Boolean,
  );
}

function logFailedResult(context: SourceCommandContext): void {
  if (shouldLogFailedResult(context.options)) {
    SourceLogger.error('source check failed', context.elapsed());
  }
}

function handlePassedResult(context: SourceCommandContext): true {
  if (shouldLogSuccess(context.options)) {
    SourceLogger.success('source check finished', context.elapsed());
  }

  context.task?.pass();
  return true;
}

function handleFailedResult(
  context: SourceCommandContext,
  sourceIssues: NonNullable<RunSourceCheckOptions['sourceIssues']>,
): false {
  const issues = createFailedSourceIssues(context.config, sourceIssues);
  recordDeferredIssues(context.options, issues);
  logFailedResult(context);
  context.task?.fail('source check failed');
  return false;
}

export async function executeSourceCommand(
  context: SourceCommandContext,
): Promise<boolean> {
  const sourceIssues = context.options.sourceIssues ?? [];
  const passed = await executeSourceCheckImpl(context, sourceIssues);

  return passed
    ? handlePassedResult(context)
    : handleFailedResult(context, sourceIssues);
}

function createUnexpectedErrorIssue(
  context: SourceCommandContext,
  error: unknown,
): CanonicalLiminaCheckIssue {
  return createTaskFailureIssue({
    code: 'LIMINA_SOURCE_CHECK_FAILED',
    filePath: context.config.configPath,
    fix: 'Inspect the source check error above, then rerun `limina source check` or `limina check`.',
    reason: `Source check failed: ${formatErrorMessage(error)}.`,
    rootDir: context.config.rootDir,
    task: 'source:check',
    title: 'Source check failed',
  });
}

function getErrorIssues(
  context: SourceCommandContext,
  error: unknown,
): LiminaCheckIssue[] {
  return error instanceof LiminaStructuredError
    ? error.issues
    : [createUnexpectedErrorIssue(context, error)];
}

function shouldLogUnexpectedError(
  options: RunSourceCheckOptions,
  error: unknown,
): boolean {
  return [
    !isReportDeferred(options),
    !(error instanceof LiminaStructuredError),
  ].every(Boolean);
}

function logUnexpectedError(
  context: SourceCommandContext,
  error: unknown,
): void {
  if (shouldLogUnexpectedError(context.options, error)) {
    SourceLogger.error(
      `source check failed: ${formatErrorMessage(error)}`,
      context.elapsed(),
    );
  }
}

export function handleSourceCommandError(
  context: SourceCommandContext,
  error: unknown,
): false {
  recordDeferredIssues(context.options, getErrorIssues(context, error));
  logUnexpectedError(context, error);
  context.task?.fail('source check failed');

  if (error instanceof LiminaStructuredError) {
    return false;
  }

  throw error;
}
