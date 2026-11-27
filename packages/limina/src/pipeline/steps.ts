import type {
  BuiltinTaskName,
  PipelineStep,
  ResolvedLiminaConfig,
} from '#config/runner';
import path from 'pathe';
import {
  planCapabilitySubscriptions,
  type SubscriptionPlan,
} from '../core/facts/subscription';
import type { ExecutionPlan, ExecutionTask } from '../execution/tasks';
import type { NormalizedPipelineStep } from './types';

const builtInTaskNames = new Set<string>([
  'checker:build',
  'checker:typecheck',
  'graph:check',
  'graph:prepare',
  'package:check',
  'proof:check',
  'release:check',
  'source:check',
]);

export const defaultCheckPipeline: readonly PipelineStep[] = [
  'checker:build',
  'graph:check',
  'source:check',
  'proof:check',
  'checker:typecheck',
];

export function planPipelineSubscriptions(
  config: ResolvedLiminaConfig,
  pipelineName: string | undefined,
): SubscriptionPlan {
  const rawSteps =
    pipelineName === undefined
      ? defaultCheckPipeline
      : (findPipelineSteps(config, pipelineName) ?? []);
  const capabilities = rawSteps.flatMap((rawStep) => {
    const step = normalizePipelineStep(rawStep);
    return step.type === 'task' ? [step.name] : [];
  });
  return planCapabilitySubscriptions(capabilities);
}

export function requiresPipelineSemanticFacts(
  config: ResolvedLiminaConfig,
  pipelineName: string | undefined,
): boolean {
  return (
    pipelineName === undefined ||
    (findPipelineSteps(config, pipelineName) !== undefined &&
      planPipelineSubscriptions(config, pipelineName).requiresSemanticFacts)
  );
}

export function isBuiltinTaskName(value: string): value is BuiltinTaskName {
  return builtInTaskNames.has(value);
}

export function assertNeverTaskName(taskName: never): never {
  throw new Error(`Unsupported built-in task: ${taskName}`);
}

export function getPipelineStepLabel(step: NormalizedPipelineStep): string {
  return step.type === 'task'
    ? step.name
    : [step.command, ...(step.args ?? [])].join(' ');
}

function createMissingPipelineMessage(
  config: ResolvedLiminaConfig,
  pipelineName: string,
): string {
  return [
    `Pipeline instruction "${pipelineName}" was not found.`,
    `Define it in ${path.relative(
      config.rootDir,
      config.configPath,
    )} under the "pipelines" field, then run "limina check ${pipelineName}" again.`,
  ].join('\n');
}

function findPipelineSteps(
  config: ResolvedLiminaConfig,
  pipelineName: string,
): readonly PipelineStep[] | undefined {
  return config.pipelines === undefined
    ? undefined
    : config.pipelines[pipelineName];
}

function requirePipelineSteps(options: {
  config: ResolvedLiminaConfig;
  pipelineName: string;
  steps: readonly PipelineStep[] | undefined;
}): readonly PipelineStep[] {
  if (options.steps === undefined) {
    throw new Error(
      createMissingPipelineMessage(options.config, options.pipelineName),
    );
  }
  if (options.steps.length === 0) {
    throw new Error(
      `Pipeline "${options.pipelineName}" must contain at least one step.`,
    );
  }
  return options.steps;
}

export function getPipelineSteps(
  config: ResolvedLiminaConfig,
  pipelineName: string,
): readonly PipelineStep[] {
  return requirePipelineSteps({
    config,
    pipelineName,
    steps: findPipelineSteps(config, pipelineName),
  });
}

function normalizeStringStep(step: string): NormalizedPipelineStep {
  if (isBuiltinTaskName(step)) return { name: step, type: 'task' };
  const [command, ...arguments_] = step.split(/\s+/u).filter(Boolean);
  if (command === undefined) {
    throw new Error('Pipeline command step must not be empty.');
  }
  return { args: arguments_, command, type: 'command' };
}

export function normalizePipelineStep(
  step: PipelineStep,
): NormalizedPipelineStep {
  return typeof step === 'string' ? normalizeStringStep(step) : step;
}

export function describePipeline(
  plan: ExecutionPlan,
): readonly Pick<ExecutionTask, 'id' | 'issueTask' | 'kind' | 'label'>[] {
  return plan.tasks.map(({ id, issueTask, kind, label }) => ({
    id,
    issueTask,
    kind,
    label,
  }));
}
