import type { BuiltinTaskName, ResolvedLiminaConfig } from '#config/runner';
import { LiminaStructuredError } from '../check-reporting/errors';
import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import { runGraphCheck, runGraphPrepare } from '../commands/graph';
import { runPackageCheck } from '../commands/package';
import { runProofCheck } from '../commands/proof';
import { runReleaseCheck } from '../commands/release';
import { runSourceCheck } from '../commands/source';
import { runCheckerBuild, runCheckerTypecheck } from '../commands/typecheck';
import type { SourceCheckIssue } from '../source-check/report';
import {
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../source-check/snapshot';
import { createSourceIssueReportOptions } from './capabilities';
import { createCheckerTaskStats } from './stats';
import type { BuiltinTaskResult, RunPipelineOptions } from './types';

interface BuiltinRunContext {
  config: ResolvedLiminaConfig;
  issues: LiminaCheckIssue[];
  options: RunPipelineOptions;
  sourceIssues: SourceCheckIssue[];
  stats: LiminaCheckRunTaskStats | undefined;
}

type BuiltinTaskHandler = (
  context: BuiltinRunContext,
) => Promise<BuiltinTaskResult>;

function createRunContext(
  config: ResolvedLiminaConfig,
  options: RunPipelineOptions,
): BuiltinRunContext {
  return {
    config,
    issues: [],
    options,
    sourceIssues: [],
    stats: undefined,
  };
}

function setStats(
  context: BuiltinRunContext,
  stats: LiminaCheckRunTaskStats,
): void {
  context.stats = stats;
}

function createResult(
  context: BuiltinRunContext,
  passed: boolean,
): BuiltinTaskResult {
  return { issues: context.issues, passed, stats: context.stats };
}

function createCommonCheckOptions(context: BuiltinRunContext) {
  return {
    clearScreen: false,
    deferSnapshot: true,
    flow: context.options.flow,
    flowDepth: 1,
    generatedGraphProvider: context.options.generatedGraphProvider,
    issues: context.issues,
    preflight: context.options.preflight,
    progress: context.options.progress,
    providers: context.options.providers,
    resolveKnipCliPath: context.options.resolveKnipCliPath,
    report: context.options.checkIssueReport,
  };
}

async function runGraphCheckTask(
  context: BuiltinRunContext,
): Promise<BuiltinTaskResult> {
  const passed = await runGraphCheck(context.config, {
    ...createCommonCheckOptions(context),
    onStats: (stats) => setStats(context, stats),
  });
  return createResult(context, passed);
}

async function runGraphPrepareTask(
  context: BuiltinRunContext,
): Promise<BuiltinTaskResult> {
  const passed = await runGraphPrepare(
    context.config,
    createCommonCheckOptions(context),
  );
  return createResult(context, passed);
}

async function runProofCheckTask(
  context: BuiltinRunContext,
): Promise<BuiltinTaskResult> {
  const passed = await runProofCheck(context.config, {
    ...createCommonCheckOptions(context),
    onStats: (stats) => setStats(context, stats),
  });
  return createResult(context, passed);
}

function createSourceSnapshotResult(options: {
  authoritative: readonly SourceCheckIssue[] | undefined;
  context: BuiltinRunContext;
  passed: boolean;
}): BuiltinTaskResult {
  if (options.authoritative === undefined) {
    return createResult(options.context, options.passed);
  }
  return {
    issues: [],
    passed: options.passed,
    sourceSnapshot: {
      issues: options.authoritative,
      status: 'completed',
    },
    stats: options.context.stats,
  };
}

async function runSourceCheckTask(
  context: BuiltinRunContext,
): Promise<BuiltinTaskResult> {
  let authoritative: readonly SourceCheckIssue[] | undefined;
  const passed = await runSourceCheck(context.config, {
    ...createCommonCheckOptions(context),
    onSourceSnapshot: (issues) => {
      authoritative = [...issues];
    },
    onStats: (stats) => setStats(context, stats),
    report: createSourceIssueReportOptions(context.options),
    sourceIssues: context.sourceIssues,
  });
  return createSourceSnapshotResult({ authoritative, context, passed });
}

function createPackageCheckOptions(context: BuiltinRunContext) {
  return {
    clearScreen: false,
    config: context.config,
    cwd: context.options.cwd,
    deferSnapshot: true,
    flow: context.options.flow,
    flowDepth: 1,
    issues: context.issues,
    onStats: (stats: LiminaCheckRunTaskStats) => setStats(context, stats),
    packageNames: context.options.packageNames,
    preflight: context.options.preflight,
    progress: context.options.progress,
    providers: context.options.providers,
    report: context.options.checkIssueReport,
  };
}

async function runPackageCheckTask(
  context: BuiltinRunContext,
): Promise<BuiltinTaskResult> {
  const passed = await runPackageCheck(createPackageCheckOptions(context));
  return createResult(context, passed);
}

async function runReleaseCheckTask(
  context: BuiltinRunContext,
): Promise<BuiltinTaskResult> {
  const passed = await runReleaseCheck(createPackageCheckOptions(context));
  return createResult(context, passed);
}

function createCheckerOptions(context: BuiltinRunContext) {
  return {
    clearScreen: false,
    config: context.config,
    cwd: context.config.rootDir,
    deferSnapshot: true,
    flow: context.options.flow,
    flowDepth: 1,
    generatedGraphProvider: context.options.generatedGraphProvider,
    issues: context.issues,
    preflight: context.options.preflight,
    progress: context.options.progress,
    providers: context.options.providers,
    report: context.options.checkIssueReport,
  };
}

async function runCheckerTypecheckTask(
  context: BuiltinRunContext,
): Promise<BuiltinTaskResult> {
  const result = await runCheckerTypecheck(createCheckerOptions(context));
  return {
    issues: context.issues,
    passed: result.passed,
    stats: createCheckerTaskStats(result),
  };
}

async function runCheckerBuildTask(
  context: BuiltinRunContext,
): Promise<BuiltinTaskResult> {
  const result = await runCheckerBuild(createCheckerOptions(context));
  return {
    issues: context.issues,
    passed: result.passed,
    stats: createCheckerTaskStats(result),
  };
}

const builtinHandlers: Record<BuiltinTaskName, BuiltinTaskHandler> = {
  'checker:build': runCheckerBuildTask,
  'checker:typecheck': runCheckerTypecheckTask,
  'graph:check': runGraphCheckTask,
  'graph:prepare': runGraphPrepareTask,
  'package:check': runPackageCheckTask,
  'proof:check': runProofCheckTask,
  'release:check': runReleaseCheckTask,
  'source:check': runSourceCheckTask,
};

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendTaskFailureIssue(options: {
  context: BuiltinRunContext;
  error: unknown;
  taskName: BuiltinTaskName;
}): void {
  const message = formatError(options.error);
  options.context.issues.push(
    createTaskFailureIssue({
      detailLines: [message],
      filePath: options.context.config.configPath,
      fix: `Inspect the ${options.taskName} error above, then rerun limina check.`,
      reason: `${options.taskName} failed: ${message}.`,
      rootDir: options.context.config.rootDir,
      task: options.taskName,
      title: `${options.taskName} failed`,
    }),
  );
}

function appendErrorIssues(options: {
  context: BuiltinRunContext;
  error: unknown;
  taskName: BuiltinTaskName;
}): void {
  if (options.context.issues.length > 0) return;
  if (options.error instanceof LiminaStructuredError) {
    options.context.issues.push(...options.error.issues);
    return;
  }
  appendTaskFailureIssue(options);
}

export async function runBuiltinTask(
  config: ResolvedLiminaConfig,
  taskName: BuiltinTaskName,
  options: RunPipelineOptions = {},
): Promise<BuiltinTaskResult> {
  const context = createRunContext(config, options);
  try {
    return await builtinHandlers[taskName](context);
  } catch (error) {
    appendErrorIssues({ context, error, taskName });
    return {
      issues: context.issues,
      passed: false,
      stats: context.stats,
    };
  }
}
