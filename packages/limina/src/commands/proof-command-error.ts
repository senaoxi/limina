import { shouldUseColor } from '#utils/reporting';
import { LiminaStructuredError } from '../check-reporting/errors';
import { formatCheckIssueHumanReport } from '../check-reporting/human';
import {
  appendCheckIssues,
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import { formatErrorMessage, ProofLogger } from '../logger';
import type { RunProofCheckOptions } from '../proof/runner';
import type { ProofCommandContext, ProofCommandTask } from './proof-command';

function isReportDeferred(options: RunProofCheckOptions): boolean {
  const report = options.report;
  return report === undefined ? false : report.defer === true;
}

function isSnapshotDeferred(options: RunProofCheckOptions): boolean {
  return options.deferSnapshot === true;
}

function createErrorFailureIssue(
  context: ProofCommandContext,
  error: unknown,
): LiminaCheckIssue {
  const errorMessage = formatErrorMessage(error);

  return createTaskFailureIssue({
    code: 'LIMINA_PROOF_CHECK_FAILED',
    detailLines: [errorMessage],
    filePath: context.config.configPath,
    fix: 'Inspect the proof check error above, then rerun `limina proof check` or `limina check`.',
    reason: `Proof check failed: ${errorMessage}.`,
    rootDir: context.config.rootDir,
    task: 'proof:check',
    title: 'Proof check failed',
  });
}

function getErrorIssues(
  context: ProofCommandContext,
  error: unknown,
): readonly LiminaCheckIssue[] {
  return error instanceof LiminaStructuredError
    ? error.issues
    : [createErrorFailureIssue(context, error)];
}

function appendDeferredIssues(
  target: LiminaCheckIssue[] | undefined,
  issues: readonly LiminaCheckIssue[],
): void {
  if (target !== undefined) {
    target.push(...issues);
  }
}

async function persistErrorIssues(
  context: ProofCommandContext,
  issues: readonly LiminaCheckIssue[],
): Promise<void> {
  if (isSnapshotDeferred(context.options)) {
    appendDeferredIssues(context.options.issues, issues);
    return;
  }

  await appendCheckIssues({
    artifactNamespace: context.preflight.artifactNamespace,
    issues,
    rootDir: context.config.rootDir,
  });
}

function getReportCommand(options: RunProofCheckOptions): string {
  const report = options.report;
  const command = report === undefined ? undefined : report.command;
  return command === undefined ? 'limina proof check' : command;
}

function getReportVerbose(options: RunProofCheckOptions): boolean | undefined {
  const report = options.report;
  return report === undefined ? undefined : report.verbose;
}

function shouldLogErrorReport(
  options: RunProofCheckOptions,
  error: unknown,
): boolean {
  return [
    !isReportDeferred(options),
    !(error instanceof LiminaStructuredError),
  ].every(Boolean);
}

function logErrorReport(
  context: ProofCommandContext,
  error: unknown,
  issues: readonly LiminaCheckIssue[],
): void {
  if (!shouldLogErrorReport(context.options, error)) {
    return;
  }

  ProofLogger.error(
    formatCheckIssueHumanReport({
      color: shouldUseColor(),
      command: getReportCommand(context.options),
      issues,
      title: 'Proof check summary',
      verbose: getReportVerbose(context.options),
    }),
    context.elapsed(),
  );
}

function getTaskErrorDetails(error: unknown): { error: unknown } | undefined {
  return error instanceof LiminaStructuredError ? undefined : { error };
}

function failTask(
  task: ProofCommandTask | undefined,
  reason: string,
  details: { error: unknown } | undefined,
): void {
  if (task === undefined) {
    return;
  }

  if (details === undefined) {
    task.fail(reason);
    return;
  }

  task.fail(reason, details);
}

export async function handleProofCommandError(
  context: ProofCommandContext,
  error: unknown,
): Promise<never> {
  const issues = getErrorIssues(context, error);
  await persistErrorIssues(context, issues);
  logErrorReport(context, error, issues);
  failTask(context.task, 'proof check failed', getTaskErrorDetails(error));
  throw error;
}
