import type {
  BuiltinTaskName,
  PipelineStep,
  ResolvedLiminaConfig,
} from '#config/runner';
import path from 'pathe';
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

export const defaultCheckPipeline: PipelineStep[] = [
  'graph:check',
  'source:check',
  'proof:check',
  'checker:build',
  'checker:typecheck',
];

export function isBuiltinTaskName(value: string): value is BuiltinTaskName {
  return builtInTaskNames.has(value);
}

export function assertNeverTaskName(taskName: never): never {
  throw new Error(`Unsupported built-in task: ${taskName}`);
}

export function getPipelineStepLabel(step: NormalizedPipelineStep): string {
  if (step.type === 'task') return step.name;
  return [step.command, ...(step.args ?? [])].join(' ');
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
  if (config.pipelines === undefined) return undefined;
  return config.pipelines[pipelineName];
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
  const [command, ...args] = step.split(/\s+/u).filter(Boolean);
  if (command === undefined) {
    throw new Error('Pipeline command step must not be empty.');
  }
  return { args, command, type: 'command' };
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
