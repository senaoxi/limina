import type { ResolvedLiminaConfig } from '#config/runner';
import { createElapsedTimer } from 'logaria/helper';
import {
  appendTaskFailureIssueIfMissing,
  completeCheckIssueSnapshot,
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import { clearCliScreen, ProofLogger } from '../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import { runProofCheckImpl, type RunProofCheckOptions } from '../proof/runner';

export interface ProofCommandTask {
  fail(reason: string, details?: { error: unknown }): void;
  pass(): void;
}

export interface ProofCommandContext {
  config: ResolvedLiminaConfig;
  elapsed: ReturnType<typeof createElapsedTimer>;
  options: RunProofCheckOptions;
  preflight: LiminaPreflightManager;
  task: ProofCommandTask | undefined;
}

function isReportDeferred(options: RunProofCheckOptions): boolean {
  const report = options.report;
  return report === undefined ? false : report.defer === true;
}

function isInteractiveFlow(options: RunProofCheckOptions): boolean {
  const flow = options.flow;
  return flow === undefined ? false : flow.interactive === true;
}

function isSnapshotDeferred(options: RunProofCheckOptions): boolean {
  return options.deferSnapshot === true;
}

function shouldClearScreen(options: RunProofCheckOptions): boolean {
  return options.clearScreen === undefined ? true : options.clearScreen;
}

function getFlowDepth(options: RunProofCheckOptions): number {
  return options.flowDepth === undefined ? 0 : options.flowDepth;
}

function createProofTask(
  options: RunProofCheckOptions,
): ProofCommandTask | undefined {
  if (options.progress !== undefined) {
    return undefined;
  }

  const flow = options.flow;
  return flow === undefined
    ? undefined
    : flow.start('proof check', { depth: getFlowDepth(options) });
}

function shouldLogStart(options: RunProofCheckOptions): boolean {
  return options.flow === undefined;
}

export function createProofCommandContext(
  config: ResolvedLiminaConfig,
  options: RunProofCheckOptions,
): ProofCommandContext {
  if (shouldClearScreen(options)) {
    clearCliScreen();
  }

  if (shouldLogStart(options)) {
    ProofLogger.info('proof check started');
  }

  return {
    config,
    elapsed: createElapsedTimer(),
    options,
    preflight: resolvePreflight(config, options),
    task: createProofTask(options),
  };
}

function shouldLogSuccess(options: RunProofCheckOptions): boolean {
  return [!isReportDeferred(options), !isInteractiveFlow(options)].every(
    Boolean,
  );
}

function passTask(task: ProofCommandTask | undefined): void {
  task?.pass();
}

function failTask(task: ProofCommandTask | undefined, reason: string): void {
  task?.fail(reason);
}

function createProofFailureIssue(options: {
  config: ResolvedLiminaConfig;
  detailLines?: readonly string[];
  fix: string;
  reason: string;
}): LiminaCheckIssue {
  return createTaskFailureIssue({
    code: 'LIMINA_PROOF_CHECK_FAILED',
    detailLines: options.detailLines,
    filePath: options.config.configPath,
    fix: options.fix,
    reason: options.reason,
    rootDir: options.config.rootDir,
    task: 'proof:check',
    title: 'Proof check failed',
  });
}

function createResultFailureIssue(
  config: ResolvedLiminaConfig,
): LiminaCheckIssue {
  return createProofFailureIssue({
    config,
    fix: 'Inspect the proof check report above, then adjust checker coverage, config.source, or proof.allowlist.',
    reason:
      'Proof check found source coverage or checker graph proof violations.',
  });
}

function appendIssue(
  target: LiminaCheckIssue[] | undefined,
  issue: LiminaCheckIssue,
): void {
  target?.push(issue);
}

async function recordFailedResult(
  context: ProofCommandContext,
  issues: readonly LiminaCheckIssue[],
): Promise<void> {
  const issue = createResultFailureIssue(context.config);

  if (isSnapshotDeferred(context.options)) {
    if (issues.length === 0) {
      appendIssue(context.options.issues, issue);
    }
    return;
  }

  await appendTaskFailureIssueIfMissing({
    artifactNamespace: context.preflight.artifactNamespace,
    issue,
    rootDir: context.config.rootDir,
  });
}

function shouldLogFailedResult(options: RunProofCheckOptions): boolean {
  return [!isReportDeferred(options), options.flow === undefined].every(
    Boolean,
  );
}

async function completeProofSnapshot(
  context: ProofCommandContext,
): Promise<void> {
  if (isSnapshotDeferred(context.options)) {
    return;
  }

  await completeCheckIssueSnapshot({
    artifactNamespace: context.preflight.artifactNamespace,
    rootDir: context.config.rootDir,
  });
}

async function handlePassedProofCheck(
  context: ProofCommandContext,
): Promise<true> {
  await completeProofSnapshot(context);

  if (shouldLogSuccess(context.options)) {
    ProofLogger.success('proof check finished', context.elapsed());
  }

  passTask(context.task);
  return true;
}

async function handleFailedProofCheck(
  context: ProofCommandContext,
  issues: readonly LiminaCheckIssue[],
): Promise<false> {
  await recordFailedResult(context, issues);

  if (shouldLogFailedResult(context.options)) {
    ProofLogger.error('proof check finished with failures', context.elapsed());
  }

  failTask(context.task, 'proof check finished with failures');
  return false;
}

export async function executeProofCommand(
  context: ProofCommandContext,
): Promise<boolean> {
  const issues = context.options.issues ?? [];
  const passed = await runProofCheckImpl(context.config, {
    deferSnapshot: context.options.deferSnapshot,
    generatedGraphProvider: context.options.generatedGraphProvider,
    issues,
    logSuccess: shouldLogSuccess(context.options),
    onStats: context.options.onStats,
    preflight: context.preflight,
    progress: context.options.progress,
    providers: context.options.providers,
    report: context.options.report,
  });

  return passed
    ? handlePassedProofCheck(context)
    : handleFailedProofCheck(context, issues);
}
