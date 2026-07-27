import type { ResolvedLiminaConfig } from '#config/runner';
import {
  runExecutionPlan,
  type RunExecutionResult,
} from '../execution/executor';
import type { CompletedRunOutcome, ExecutionPlan } from '../execution/tasks';
import type { LiminaFlowTask } from '../flow';
import { LiminaPreflightManager } from '../preflight';
import {
  reportAutoCheckerCapabilities,
  reportCheckerCapabilities,
  usesAutoCheckers,
} from './capabilities';
import { createDefaultExecutionPlan, createExecutionPlan } from './plan';
import type { RunPipelineOptions } from './types';

function reportPostCommitProjectionWarning(error: unknown): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `limina warning: parent flow completion projection failed: ${message}\n`,
    );
  } catch {
    // Post-commit diagnostics must never alter committed execution.
  }
}

function getBlockedMessage(options: {
  base: string;
  outcome: CompletedRunOutcome;
}): string {
  const blocker = options.outcome.blocker;
  return blocker === undefined
    ? options.base
    : `${options.base} at ${blocker.label}`;
}

interface ParentFlowProjectionOptions {
  blockedMessage: string;
  failedMessage: string;
  outcome: CompletedRunOutcome;
  passedMessage?: string;
  task: LiminaFlowTask | undefined;
}

function projectPassedOutcome(options: ParentFlowProjectionOptions): void {
  options.task?.pass(options.passedMessage);
}

function projectBlockedOutcome(options: ParentFlowProjectionOptions): void {
  options.task?.fail(
    getBlockedMessage({
      base: options.blockedMessage,
      outcome: options.outcome,
    }),
  );
}

function projectFailedOutcome(options: ParentFlowProjectionOptions): void {
  options.task?.fail(options.failedMessage);
}

const outcomeProjectors: Record<
  CompletedRunOutcome['state'],
  (options: ParentFlowProjectionOptions) => void
> = {
  blocked: projectBlockedOutcome,
  failed: projectFailedOutcome,
  passed: projectPassedOutcome,
};

function projectOutcome(options: ParentFlowProjectionOptions): void {
  outcomeProjectors[options.outcome.state](options);
}

function projectParentFlowCompletion(
  options: ParentFlowProjectionOptions,
): void {
  try {
    projectOutcome(options);
  } catch (error) {
    reportPostCommitProjectionWarning(error);
  }
}

function createPreflight(
  config: ResolvedLiminaConfig,
  options: RunPipelineOptions,
): LiminaPreflightManager {
  if (options.preflight !== undefined) return options.preflight;
  return new LiminaPreflightManager({
    config,
    generatedGraphProvider: options.generatedGraphProvider,
    providers: options.providers,
  });
}

function getSnapshotWriterOptions(options: RunPipelineOptions) {
  return options.snapshotWriters === undefined
    ? {}
    : { snapshotWriters: options.snapshotWriters };
}

async function executePipelinePlan(options: {
  command: string;
  config: ResolvedLiminaConfig;
  pipelineOptions: RunPipelineOptions;
  plan: ExecutionPlan;
  preflight: LiminaPreflightManager;
}): Promise<RunExecutionResult> {
  return runExecutionPlan(options.plan, {
    checkRunRecorder: options.pipelineOptions.checkRunRecorder,
    command: options.command,
    flow: options.pipelineOptions.flow,
    preflight: options.preflight,
    rootDir: options.config.rootDir,
    ...getSnapshotWriterOptions(options.pipelineOptions),
  });
}

function getPipelineCommand(
  options: RunPipelineOptions,
  pipelineName: string,
): string {
  return options.checkIssueReport?.command ?? `limina check ${pipelineName}`;
}

function resolvePipelinePlan(options: {
  config: ResolvedLiminaConfig;
  pipelineName: string;
  pipelineOptions: RunPipelineOptions;
}): ExecutionPlan {
  if (options.pipelineOptions.executionPlan !== undefined) {
    return options.pipelineOptions.executionPlan;
  }
  return createExecutionPlan(
    options.config,
    options.pipelineName,
    options.pipelineOptions,
  );
}

function startPipelineTask(options: {
  label: string;
  pipelineOptions: RunPipelineOptions;
}): LiminaFlowTask | undefined {
  if (options.pipelineOptions.flow === undefined) return undefined;
  return options.pipelineOptions.flow.start(options.label, {
    collapseOnSuccess: false,
  });
}

export async function runPipelineWithResult(
  config: ResolvedLiminaConfig,
  pipelineName: string,
  options: RunPipelineOptions = {},
): Promise<RunExecutionResult> {
  const plan = resolvePipelinePlan({
    config,
    pipelineName,
    pipelineOptions: options,
  });
  const pipelineTask = startPipelineTask({
    label: `pipeline: ${pipelineName}`,
    pipelineOptions: options,
  });
  const execution = await executePipelinePlan({
    command: getPipelineCommand(options, pipelineName),
    config,
    pipelineOptions: options,
    plan,
    preflight: createPreflight(config, options),
  });
  projectParentFlowCompletion({
    blockedMessage: `pipeline blocked: ${pipelineName}`,
    failedMessage: `pipeline finished with failures: ${pipelineName}`,
    outcome: execution.outcome,
    task: pipelineTask,
  });
  return execution;
}

export async function runPipeline(
  config: ResolvedLiminaConfig,
  pipelineName: string,
  options: RunPipelineOptions = {},
): Promise<boolean> {
  return (await runPipelineWithResult(config, pipelineName, options)).passed;
}

function reportConfiguredCheckerCapabilities(
  config: ResolvedLiminaConfig,
  options: RunPipelineOptions,
): boolean {
  const auto = usesAutoCheckers(config);
  if (!auto) reportCheckerCapabilities(config, options.flow);
  return auto;
}

async function reportGeneratedCheckerCapabilities(options: {
  auto: boolean;
  config: ResolvedLiminaConfig;
  pipelineOptions: RunPipelineOptions;
  preflight: LiminaPreflightManager;
}): Promise<void> {
  if (!options.auto) return;
  try {
    await reportAutoCheckerCapabilities(
      options.config,
      options.pipelineOptions.flow,
      options.preflight,
    );
  } catch (error) {
    reportPostCommitProjectionWarning(error);
  }
}

function resolveDefaultPlan(
  config: ResolvedLiminaConfig,
  options: RunPipelineOptions,
): ExecutionPlan {
  if (options.executionPlan !== undefined) return options.executionPlan;
  return createDefaultExecutionPlan(config, options);
}

function getDefaultCheckCommand(options: RunPipelineOptions): string {
  return options.checkIssueReport?.command ?? 'limina check';
}

export async function runDefaultCheckWithResult(
  config: ResolvedLiminaConfig,
  options: RunPipelineOptions = {},
): Promise<RunExecutionResult> {
  const plan = resolveDefaultPlan(config, options);
  const pipelineTask = startPipelineTask({
    label: 'default check',
    pipelineOptions: options,
  });
  const preflight = createPreflight(config, options);
  const auto = reportConfiguredCheckerCapabilities(config, options);
  const execution = await executePipelinePlan({
    command: getDefaultCheckCommand(options),
    config,
    pipelineOptions: options,
    plan,
    preflight,
  });
  await reportGeneratedCheckerCapabilities({
    auto,
    config,
    pipelineOptions: options,
    preflight,
  });
  projectParentFlowCompletion({
    blockedMessage: 'default check blocked',
    failedMessage: 'default check finished with failures',
    outcome: execution.outcome,
    task: pipelineTask,
  });
  return execution;
}

export async function runDefaultCheck(
  config: ResolvedLiminaConfig,
  options: RunPipelineOptions = {},
): Promise<boolean> {
  return (await runDefaultCheckWithResult(config, options)).passed;
}
