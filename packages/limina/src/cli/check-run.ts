import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import { shouldUseColor } from '#utils/reporting';
import { DEFAULT_VISIBLE_ISSUE_LIMIT } from '../check-reporting/inventory-presentation';
import { createCheckRunRecorder } from '../check-reporting/run-recorder';
import { formatCheckRunSummaryHuman } from '../check-reporting/summary';
import type { RunExecutionResult } from '../execution/executor';
import {
  createDefaultExecutionPlan,
  createExecutionPlan,
  runDefaultCheckWithResult,
  runPipelineWithResult,
} from '../pipeline/runner';
import { LiminaPreflightManager } from '../preflight';
import { createProfilingMetricsRecorder } from '../profiling/metrics';
import { createCheckProfileSession } from '../profiling/session';
import { loadCliConfig } from './command-runtime';
import { createCliFlow, runCheckWithCliFlowCleanup } from './flow';
import { createSourceIssueReportOptions, parsePackageNames } from './parse';
import type { CheckFlags } from './types';

interface CheckRunState {
  executionResult?: RunExecutionResult;
  passed: boolean;
  recorder?: ReturnType<typeof createCheckRunRecorder>;
}

type CheckPlanOptions = Parameters<typeof createDefaultExecutionPlan>[1];
type CheckPlan = ReturnType<typeof createDefaultExecutionPlan>;
type CheckFlow = ReturnType<typeof createCliFlow>;
type ProfileMetrics = ReturnType<typeof createProfilingMetricsRecorder>;
type ProfileSession = Awaited<ReturnType<typeof createCheckProfileSession>>;

interface CheckExecutionContext {
  command: string;
  config: ResolvedLiminaConfig;
  flow: CheckFlow;
  pipeline: string | undefined;
  plan: CheckPlan;
  planOptions: CheckPlanOptions;
  preflight: LiminaPreflightManager;
  profileSession: ProfileSession | undefined;
}

function createProfileMetrics(): ProfileMetrics | undefined {
  if (process.env.LIMINA_PROFILE !== '1') return undefined;
  return createProfilingMetricsRecorder();
}

function getConfigLoaderField(flags: CheckFlags): { configLoader?: string } {
  if (flags.configLoader === undefined) return {};
  return { configLoader: flags.configLoader };
}

function getConfigPathField(options: {
  configPath: string;
  flags: CheckFlags;
}): { configPath?: string } {
  if (options.flags.config === undefined) return {};
  return { configPath: normalizeAbsolutePathIdentity(options.configPath) };
}

function getModeField(flags: CheckFlags): { mode?: string } {
  if (flags.mode === undefined) return {};
  return { mode: flags.mode };
}

function createSummaryGlobalContext(options: {
  configPath: string;
  flags: CheckFlags;
}): {
  configLoader?: string;
  configPath?: string;
  mode?: string;
} {
  return {
    ...getConfigLoaderField(options.flags),
    ...getConfigPathField(options),
    ...getModeField(options.flags),
  };
}

function getRecordedRun(
  state: CheckRunState,
):
  | ReturnType<ReturnType<typeof createCheckRunRecorder>['getRunSummary']>
  | undefined {
  if (state.recorder === undefined) return undefined;
  return state.recorder.getRunSummary();
}

function getSummaryState(state: CheckRunState): {
  execution: RunExecutionResult;
  run: NonNullable<ReturnType<typeof getRecordedRun>>;
} | null {
  const run = getRecordedRun(state);
  if (run === undefined) return null;
  if (state.executionResult === undefined) return null;
  return { execution: state.executionResult, run };
}

function writeCheckSummary(options: {
  configPath: string;
  flags: CheckFlags;
  rootDir: string;
  state: CheckRunState;
}): void {
  const summary = getSummaryState(options.state);
  if (summary === null) return;
  const verbose = options.flags.verbose === true;
  process.stdout.write(
    `\n${formatCheckRunSummaryHuman({
      color: shouldUseColor(),
      issues: summary.execution.issues,
      queryContext: {
        effectiveFormat: 'human',
        filters: {},
        global: createSummaryGlobalContext({
          configPath: options.configPath,
          flags: options.flags,
        }),
        limit: DEFAULT_VISIBLE_ISSUE_LIMIT,
        limitExplicit: false,
        verbose,
      },
      rootDir: options.rootDir,
      run: summary.run,
      verbose: options.flags.verbose,
    })}\n`,
  );
}

function createCommandLabel(pipeline: string | undefined): string {
  if (pipeline === undefined) return 'limina check';
  return `limina check ${pipeline}`;
}

async function createProfileSessionIfEnabled(options: {
  command: string;
  metrics: ProfileMetrics | undefined;
  preflight: LiminaPreflightManager;
}): Promise<ProfileSession | undefined> {
  if (options.metrics === undefined) return undefined;
  return createCheckProfileSession({
    artifactNamespace: options.preflight.artifactNamespace,
    command: options.command,
    metrics: options.metrics,
  });
}

function createPlan(options: {
  config: ResolvedLiminaConfig;
  pipeline: string | undefined;
  planOptions: CheckPlanOptions;
}): CheckPlan {
  if (options.pipeline === undefined) {
    return createDefaultExecutionPlan(options.config, options.planOptions);
  }
  return createExecutionPlan(
    options.config,
    options.pipeline,
    options.planOptions,
  );
}

function getPipelineName(pipeline: string | undefined): string {
  if (pipeline === undefined) return 'default';
  return pipeline;
}

function createRecorder(
  context: CheckExecutionContext,
): ReturnType<typeof createCheckRunRecorder> {
  return createCheckRunRecorder({
    command: context.command,
    configPath: context.config.configPath,
    pipeline: getPipelineName(context.pipeline),
    plannedTasks: context.plan.tasks,
    rootDir: context.config.rootDir,
  });
}

async function executePlannedCheck(options: {
  context: CheckExecutionContext;
  recorder: ReturnType<typeof createCheckRunRecorder>;
}): Promise<RunExecutionResult> {
  const executionOptions = {
    ...options.context.planOptions,
    checkRunRecorder: options.recorder,
    executionPlan: options.context.plan,
    flow: options.context.flow,
  };
  if (options.context.pipeline === undefined) {
    return runDefaultCheckWithResult(options.context.config, executionOptions);
  }
  return runPipelineWithResult(
    options.context.config,
    options.context.pipeline,
    executionOptions,
  );
}

async function executeCheckFlow(
  context: CheckExecutionContext,
  state: CheckRunState,
): Promise<boolean> {
  context.flow.intro('limina check');
  state.recorder = createRecorder(context);
  state.executionResult = await executePlannedCheck({
    context,
    recorder: state.recorder,
  });
  return state.executionResult.passed;
}

async function finishProfile(options: {
  session: ProfileSession | undefined;
  state: CheckRunState;
}): Promise<void> {
  if (options.session === undefined) return;
  await options.session.finish({
    passed: options.state.passed,
    run: getRecordedRun(options.state),
  });
}

async function finalizeCheckRun(
  context: CheckExecutionContext,
  state: CheckRunState,
): Promise<void> {
  try {
    await finishProfile({ session: context.profileSession, state });
  } finally {
    context.preflight.dispose();
  }
}

async function createExecutionContext(options: {
  flags: CheckFlags;
  pipeline: string | undefined;
}): Promise<CheckExecutionContext> {
  const config = await loadCliConfig(options.flags, 'check');
  const command = createCommandLabel(options.pipeline);
  const metrics = createProfileMetrics();
  const preflight = new LiminaPreflightManager({ config, metrics });
  const profileSession = await createProfileSessionIfEnabled({
    command,
    metrics,
    preflight,
  });
  const sourceIssueReport = {
    ...createSourceIssueReportOptions(options.flags, command),
    defer: true,
  };
  const planOptions: CheckPlanOptions = {
    checkIssueReport: {
      command,
      defer: true,
      verbose: options.flags.verbose,
    },
    cwd: process.cwd(),
    packageNames: parsePackageNames(options.flags.package),
    preflight,
    sourceIssueReport,
  };
  return {
    command,
    config,
    flow: createCliFlow({ check: true, clearScreen: false }),
    pipeline: options.pipeline,
    plan: createPlan({ config, pipeline: options.pipeline, planOptions }),
    planOptions,
    preflight,
    profileSession,
  };
}

export async function runConfiguredCheck(options: {
  flags: CheckFlags;
  pipeline: string | undefined;
}): Promise<void> {
  const context = await createExecutionContext(options);
  const state: CheckRunState = { passed: false };
  try {
    state.passed = await runCheckWithCliFlowCleanup(context.flow, () =>
      executeCheckFlow(context, state),
    );
  } finally {
    await finalizeCheckRun(context, state);
  }
  if (!state.passed) process.exitCode = 1;
  writeCheckSummary({
    configPath: context.config.configPath,
    flags: options.flags,
    rootDir: context.config.rootDir,
    state,
  });
}
