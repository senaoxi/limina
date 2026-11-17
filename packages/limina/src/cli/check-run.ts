import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import { shouldUseColor } from '#utils/reporting';
import {
  collectFrameworkInferenceIssues,
  formatFrameworkInferenceWarnings,
} from '../check-reporting/framework-inference';
import { DEFAULT_VISIBLE_ISSUE_LIMIT } from '../check-reporting/inventory-presentation';
import { createCheckRunRecorder } from '../check-reporting/run-recorder';
import { formatCheckRunSummaryHuman } from '../check-reporting/summary';
import type { RunExecutionResult } from '../execution/executor';
import { ExecutionTrace } from '../execution/trace';
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
  trace?: ExecutionTrace;
  config: ResolvedLiminaConfig;
  flow: CheckFlow;
  pipeline: string | undefined;
  plan: CheckPlan;
  planOptions: CheckPlanOptions;
  preflight: LiminaPreflightManager;
  profileSession: ProfileSession | undefined;
}

function createProfileMetrics(): ProfileMetrics | undefined {
  return process.env.LIMINA_PROFILE === '1'
    ? createProfilingMetricsRecorder()
    : undefined;
}

function getConfigLoaderField(flags: CheckFlags): { configLoader?: string } {
  return flags.configLoader === undefined
    ? {}
    : { configLoader: flags.configLoader };
}

function getConfigPathField(options: {
  configPath: string;
  flags: CheckFlags;
}): { configPath?: string } {
  return options.flags.config === undefined
    ? {}
    : { configPath: normalizeAbsolutePathIdentity(options.configPath) };
}

function getModeField(flags: CheckFlags): { mode?: string } {
  return flags.mode === undefined ? {} : { mode: flags.mode };
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
  return state.recorder === undefined
    ? undefined
    : state.recorder.getRunSummary();
}

function getSummaryState(state: CheckRunState): {
  execution: RunExecutionResult;
  run: NonNullable<ReturnType<typeof getRecordedRun>>;
} | null {
  const run = getRecordedRun(state);
  return run === undefined || state.executionResult === undefined
    ? null
    : { execution: state.executionResult, run };
}

function writeCheckSummary(options: {
  configPath: string;
  flags: CheckFlags;
  rootDir: string;
  state: CheckRunState;
}): void {
  const summary = getSummaryState(options.state);
  if (summary === null) return;
  const isVerbose = options.flags.verbose === true;
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
        verbose: isVerbose,
      },
      rootDir: options.rootDir,
      run: summary.run,
      verbose: options.flags.verbose,
    })}\n`,
  );
}

function createCommandLabel(pipeline: string | undefined): string {
  return pipeline === undefined ? 'limina check' : `limina check ${pipeline}`;
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
  return options.pipeline === undefined
    ? createDefaultExecutionPlan(options.config, options.planOptions)
    : createExecutionPlan(
        options.config,
        options.pipeline,
        options.planOptions,
      );
}

function createRecorder(
  context: CheckExecutionContext,
): ReturnType<typeof createCheckRunRecorder> {
  return createCheckRunRecorder({
    command: context.command,
    trace: context.trace,
    configPath: context.config.configPath,
    pipeline: context.pipeline ?? 'default',
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
  return options.context.pipeline === undefined
    ? runDefaultCheckWithResult(options.context.config, executionOptions)
    : runPipelineWithResult(
        options.context.config,
        options.context.pipeline,
        executionOptions,
      );
}

async function isExecuteCheckFlow(
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
  trace?: ExecutionTrace;
}): Promise<void> {
  if (options.session === undefined) return;
  await options.session.finish({
    passed: options.state.passed,
    run: getRecordedRun(options.state),
    trace: options.trace?.snapshot(),
  });
}

async function finalizeCheckRun(
  context: CheckExecutionContext,
  state: CheckRunState,
): Promise<void> {
  const startedAt = context.trace?.now();
  context.preflight.dispose();
  if (startedAt !== undefined)
    context.trace?.phase('preflight-disposal', startedAt);
  await finishProfile({
    session: context.profileSession,
    state,
    trace: context.trace,
  });
}

async function createExecutionContext(options: {
  flags: CheckFlags;
  pipeline: string | undefined;
  trace?: ExecutionTrace;
}): Promise<CheckExecutionContext> {
  const configStart = options.trace?.now();
  const config = await loadCliConfig(options.flags, 'check');
  if (configStart !== undefined)
    options.trace?.phase('config-load', configStart);
  const setupStart = options.trace?.now();
  const command = createCommandLabel(options.pipeline);
  const metrics = createProfileMetrics();
  const preflight = new LiminaPreflightManager({
    config,
    metrics,
    analysisCache: true,
    forceAnalysisCache: options.flags.force === true,
  });
  try {
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
    const plan = createPlan({
      config,
      pipeline: options.pipeline,
      planOptions,
    });
    const flow = createCliFlow({ check: true });
    const profileSession = await createProfileSessionIfEnabled({
      command,
      metrics,
      preflight,
    });
    if (setupStart !== undefined)
      options.trace?.phase('preflight-and-profile-setup', setupStart);
    return {
      command,
      trace: options.trace,
      config,
      flow,
      pipeline: options.pipeline,
      plan,
      planOptions,
      preflight,
      profileSession,
    };
  } catch (error) {
    preflight.dispose();
    throw error;
  }
}

export async function runConfiguredCheck(options: {
  flags: CheckFlags;
  pipeline: string | undefined;
}): Promise<void> {
  const trace =
    process.env.LIMINA_PROFILE === '1' ? new ExecutionTrace() : undefined;
  const context = await createExecutionContext({ ...options, trace });
  const executionStart = trace?.now();
  const state: CheckRunState = { passed: false };
  try {
    try {
      state.passed = await runCheckWithCliFlowCleanup(context.flow, () =>
        isExecuteCheckFlow(context, state),
      );
    } finally {
      if (executionStart !== undefined)
        trace?.phase('check-execution-and-reporting', executionStart);
      await finalizeCheckRun(context, state);
    }
  } catch (error) {
    const warnings = formatFrameworkInferenceWarnings(
      collectFrameworkInferenceIssues(context.preflight),
      shouldUseColor(),
    );
    if (warnings.length > 0) process.stderr.write(`\n${warnings}\n`);
    throw error;
  }
  if (!state.passed) process.exitCode = 1;
  writeCheckSummary({
    configPath: context.config.configPath,
    flags: options.flags,
    rootDir: context.config.rootDir,
    state,
  });
}
