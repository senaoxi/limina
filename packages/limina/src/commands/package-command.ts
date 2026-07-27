import { shouldUseColor } from '#utils/reporting';
import { createElapsedTimer } from 'logaria/helper';
import { LiminaStructuredError } from '../check-reporting/errors';
import { formatCheckIssueHumanReport } from '../check-reporting/human';
import {
  appendCheckIssues,
  completeCheckIssueSnapshot,
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import { clearCliScreen, formatErrorMessage, PackageLogger } from '../logger';
import {
  runPackageCheckImpl,
  type RunPackageCheckOptions,
} from '../package-check/runner';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';

interface PackageCommandTask {
  fail(reason: string, details?: { error: unknown }): void;
  pass(): void;
}

export interface PackageCommandContext {
  elapsed: ReturnType<typeof createElapsedTimer>;
  options: RunPackageCheckOptions;
  preflight: LiminaPreflightManager;
  task: PackageCommandTask | undefined;
}

function isReportDeferred(options: RunPackageCheckOptions): boolean {
  const report = options.report;
  return report === undefined ? false : report.defer === true;
}

function isInteractiveFlow(options: RunPackageCheckOptions): boolean {
  const flow = options.flow;
  return flow === undefined ? false : flow.interactive === true;
}

function isSnapshotDeferred(options: RunPackageCheckOptions): boolean {
  return options.deferSnapshot === true;
}

function shouldClearScreen(options: RunPackageCheckOptions): boolean {
  return options.clearScreen === undefined ? true : options.clearScreen;
}

function getFlowDepth(options: RunPackageCheckOptions): number {
  return options.flowDepth === undefined ? 0 : options.flowDepth;
}

function createPackageTask(
  options: RunPackageCheckOptions,
): PackageCommandTask | undefined {
  if (options.progress !== undefined) {
    return undefined;
  }

  const flow = options.flow;
  return flow === undefined
    ? undefined
    : flow.start('package check', { depth: getFlowDepth(options) });
}

function logPackageStart(options: RunPackageCheckOptions): void {
  if (!isReportDeferred(options)) {
    PackageLogger.info('package check started');
  }
}

export function createPackageCommandContext(
  options: RunPackageCheckOptions,
): PackageCommandContext {
  const context = {
    elapsed: createElapsedTimer(),
    options,
    preflight: resolvePreflight(options.config, options),
    task: createPackageTask(options),
  };

  if (shouldClearScreen(options)) {
    clearCliScreen();
  }

  logPackageStart(options);
  return context;
}

function getSinglePackageName(
  options: RunPackageCheckOptions,
): string | undefined {
  const packageNames = options.packageNames;

  if (packageNames === undefined) {
    return undefined;
  }

  return packageNames.length === 1 ? packageNames[0] : undefined;
}

function getPackageTool(options: RunPackageCheckOptions): string {
  return options.tool === undefined ? 'all' : options.tool;
}

function createPackageFailureIssue(options: {
  commandOptions: RunPackageCheckOptions;
  detailLines?: readonly string[];
  fix: string;
  reason: string;
}): LiminaCheckIssue {
  return createTaskFailureIssue({
    code: 'LIMINA_PACKAGE_CHECK_FAILED',
    detailLines: options.detailLines,
    filePath: options.commandOptions.config.configPath,
    fix: options.fix,
    packageName: getSinglePackageName(options.commandOptions),
    reason: options.reason,
    rootDir: options.commandOptions.config.rootDir,
    task: 'package:check',
    title: 'Package check failed',
    tool: getPackageTool(options.commandOptions),
  });
}

function createUnstructuredResultIssue(
  options: RunPackageCheckOptions,
): LiminaCheckIssue {
  return createPackageFailureIssue({
    commandOptions: options,
    fix: 'Inspect the package check report above, then rerun `limina package check` or the package pipeline.',
    reason:
      'Package check found package manifest, publint, ATTW, or published boundary failures.',
  });
}

function createUnexpectedErrorIssue(
  error: unknown,
  options: RunPackageCheckOptions,
): LiminaCheckIssue {
  const errorMessage = formatErrorMessage(error);

  return createPackageFailureIssue({
    commandOptions: options,
    detailLines: [errorMessage],
    fix: 'Inspect the package check error above, then rerun `limina package check` or the package pipeline.',
    reason: `Package check failed: ${errorMessage}.`,
  });
}

function createPackageCheckErrorIssues(
  error: unknown,
  options: RunPackageCheckOptions,
): readonly LiminaCheckIssue[] {
  return error instanceof LiminaStructuredError
    ? error.issues
    : [createUnexpectedErrorIssue(error, options)];
}

function selectResultIssues(
  issues: readonly LiminaCheckIssue[],
  options: RunPackageCheckOptions,
): readonly LiminaCheckIssue[] {
  return issues.length > 0 ? issues : [createUnstructuredResultIssue(options)];
}

function appendDeferredIssues(
  target: LiminaCheckIssue[] | undefined,
  issues: readonly LiminaCheckIssue[],
): void {
  if (target !== undefined) {
    target.push(...issues);
  }
}

async function persistPackageIssues(
  context: PackageCommandContext,
  issues: readonly LiminaCheckIssue[],
): Promise<void> {
  if (isSnapshotDeferred(context.options)) {
    appendDeferredIssues(context.options.issues, issues);
    return;
  }

  await appendCheckIssues({
    artifactNamespace: context.preflight.artifactNamespace,
    issues,
    rootDir: context.options.config.rootDir,
  });
}

function getReportCommand(options: RunPackageCheckOptions): string {
  const report = options.report;
  const command = report === undefined ? undefined : report.command;
  return command === undefined ? 'limina package check' : command;
}

function getReportVerbose(
  options: RunPackageCheckOptions,
): boolean | undefined {
  const report = options.report;
  return report === undefined ? undefined : report.verbose;
}

function logIssueReport(
  context: PackageCommandContext,
  issues: readonly LiminaCheckIssue[],
): void {
  if (isReportDeferred(context.options)) {
    return;
  }

  PackageLogger.error(
    formatCheckIssueHumanReport({
      color: shouldUseColor(),
      command: getReportCommand(context.options),
      issues,
      title: 'Package check summary',
      verbose: getReportVerbose(context.options),
    }),
    context.elapsed(),
  );
}

function shouldLogSuccess(options: RunPackageCheckOptions): boolean {
  return [!isReportDeferred(options), !isInteractiveFlow(options)].every(
    Boolean,
  );
}

function passTask(task: PackageCommandTask | undefined): void {
  task?.pass();
}

function failTask(
  task: PackageCommandTask | undefined,
  reason: string,
  details?: { error: unknown },
): void {
  task?.fail(reason, details);
}

async function handlePassedPackageCheck(
  context: PackageCommandContext,
): Promise<true> {
  if (!isSnapshotDeferred(context.options)) {
    await completeCheckIssueSnapshot({
      artifactNamespace: context.preflight.artifactNamespace,
      rootDir: context.options.config.rootDir,
    });
  }

  if (shouldLogSuccess(context.options)) {
    PackageLogger.success('package check finished', context.elapsed());
  }

  passTask(context.task);
  return true;
}

async function handleFailedPackageCheck(
  context: PackageCommandContext,
  issues: readonly LiminaCheckIssue[],
): Promise<false> {
  const reportIssues = selectResultIssues(issues, context.options);
  await persistPackageIssues(context, reportIssues);
  logIssueReport(context, reportIssues);
  failTask(context.task, 'package check finished with failures');
  return false;
}

export async function executePackageCommand(
  context: PackageCommandContext,
): Promise<boolean> {
  const issues: LiminaCheckIssue[] = [];
  const passed = await runPackageCheckImpl({
    ...context.options,
    issues,
    preflight: context.preflight,
  });
  return passed
    ? handlePassedPackageCheck(context)
    : handleFailedPackageCheck(context, issues);
}

function getErrorDetails(error: unknown): { error: unknown } | undefined {
  return error instanceof LiminaStructuredError ? undefined : { error };
}

export async function handlePackageCommandError(
  context: PackageCommandContext,
  error: unknown,
): Promise<never> {
  const issues = createPackageCheckErrorIssues(error, context.options);
  await persistPackageIssues(context, issues);
  logIssueReport(context, issues);
  failTask(context.task, 'package check failed', getErrorDetails(error));
  throw error;
}
