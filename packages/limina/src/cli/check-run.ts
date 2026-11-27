import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import { shouldUseColor } from '#utils/reporting';
import { currentProfile } from '../application/analysis/observability';
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
import {
  planPipelineSubscriptions,
  requiresPipelineSemanticFacts,
} from '../pipeline/steps';
import { LiminaPreflightManager } from '../preflight';
import {
  qualifyProfileRuntime,
  readProfileRuntimeExpectations,
} from '../profiling/runtime-expectations';
import { loadCliConfig } from './command-runtime';
import { createCliFlow, runCheckWithCliFlowCleanup } from './flow';
import { createSourceIssueReportOptions, parsePackageNames } from './parse';
import { observeCliPhase } from './profiling';
import type { CheckFlags } from './types';

interface CheckRunState {
  executionResult?: RunExecutionResult;
  passed: boolean;
  recorder?: ReturnType<typeof createCheckRunRecorder>;
}

type CheckPlanOptions = Parameters<typeof createDefaultExecutionPlan>[1];
type CheckPlan = ReturnType<typeof createDefaultExecutionPlan>;
type CheckFlow = ReturnType<typeof createCliFlow>;

interface CheckExecutionContext {
  command: string;
  trace?: ExecutionTrace;
  config: ResolvedLiminaConfig;
  flow: CheckFlow;
  pipeline: string | undefined;
  plan: CheckPlan;
  planOptions: CheckPlanOptions;
  preflight: LiminaPreflightManager;
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

async function observeExpectedProfileRuntime(): Promise<void> {
  const profile = currentProfile();
  if (profile === undefined) return;
  const expectations = readProfileRuntimeExpectations();
  if (expectations === undefined) return;
  const runtime = await observeCliPhase('profile.runtime-identity', () =>
    qualifyProfileRuntime(expectations),
  );
  profile.runtime({ entry: runtime.entryKind, treeHash: runtime.treeHash });
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

function finalizeCheckRun(
  context: CheckExecutionContext,
  state: CheckRunState,
): void {
  context.preflight.dispose();
  const observer = currentProfile();
  if (observer !== undefined && context.trace !== undefined) {
    try {
      const work = observer.start('profile.task-projection');
      context.trace.reportProfileTasks(observer, context.plan.tasks);
      const durationMs = getRecordedRun(state)?.durationMs;
      if (durationMs !== undefined)
        observer.runDuration(Math.round(durationMs * 1000));
      observer.finish(work);
    } catch {
      // A projection failure cannot replace the command result.
    }
  }
}

async function createExecutionContext(options: {
  flags: CheckFlags;
  pipeline: string | undefined;
  trace?: ExecutionTrace;
}): Promise<CheckExecutionContext> {
  const config = await loadCliConfig(options.flags, 'check');
  const command = createCommandLabel(options.pipeline);
  const subscriptionPlan = planPipelineSubscriptions(config, options.pipeline);
  const requiresSemanticCache = requiresPipelineSemanticFacts(
    config,
    options.pipeline,
  );
  currentProfile()?.setPolicy(
    !requiresSemanticCache || config.cache === false
      ? 'disabled'
      : options.flags.force === true
        ? 'forced'
        : 'read-write',
  );
  const preflight = new LiminaPreflightManager({
    config,
    analysisCache: requiresSemanticCache,
    forceAnalysisCache: options.flags.force === true,
    subscriptionPlan,
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
    await observeExpectedProfileRuntime();
    return {
      command,
      trace: options.trace,
      config,
      flow,
      pipeline: options.pipeline,
      plan,
      planOptions,
      preflight,
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
    currentProfile() === undefined ? undefined : new ExecutionTrace();
  const context = await createExecutionContext({ ...options, trace });
  const state: CheckRunState = { passed: false };
  try {
    try {
      state.passed = await runCheckWithCliFlowCleanup(context.flow, () =>
        isExecuteCheckFlow(context, state),
      );
    } finally {
      finalizeCheckRun(context, state);
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
