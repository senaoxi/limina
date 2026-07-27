import type { BuiltinTaskName, ResolvedLiminaConfig } from '#config/runner';
import { LiminaStructuredError } from '../check-reporting/errors';
import type {
  ExecutionTask,
  ExecutionTaskRunResult,
  TaskId,
} from '../execution/tasks';
import { taskId } from '../execution/tasks';
import { createTaskFailureIssue } from '../source-check/snapshot';
import { runBuiltinTask } from './builtin-runner';
import { runCommandStep } from './command-runner';
import { getBuiltinTaskResources } from './resources';
import { getPipelineStepLabel } from './steps';
import type {
  BuiltinTaskResult,
  NormalizedPipelineStep,
  RunPipelineOptions,
} from './types';

export const filesystemDependentTasks: ReadonlySet<BuiltinTaskName> = new Set([
  'checker:build',
  'checker:typecheck',
  'graph:prepare',
]);

function toExecutionTaskRunResult(
  result: BuiltinTaskResult,
): ExecutionTaskRunResult {
  return {
    issues: result.issues,
    sourceSnapshot: result.sourceSnapshot,
    stats: result.stats,
    status: result.passed ? 'passed' : 'failed',
  };
}

export function createBuiltinExecutionTask(options: {
  config: ResolvedLiminaConfig;
  generation: number;
  id: TaskId;
  pipelineOptions: RunPipelineOptions;
  step: Extract<NormalizedPipelineStep, { type: 'task' }>;
}): ExecutionTask {
  return {
    failPolicy: 'continue',
    generation: options.generation,
    id: options.id,
    issueTask: options.step.name,
    kind: 'task',
    label: getPipelineStepLabel(options.step),
    order: 0,
    resources: getBuiltinTaskResources(options.step.name),
    run: async (context) =>
      toExecutionTaskRunResult(
        await runBuiltinTask(options.config, options.step.name, {
          ...options.pipelineOptions,
          flow: context.flow,
          generatedGraphProvider: () =>
            context.preflight.ensureGeneratedGraph(),
          preflight: context.preflight,
          progress: context.progress,
          providers: context.preflight.providers,
        }),
      ),
  };
}

export function createCommandExecutionTask(options: {
  config: ResolvedLiminaConfig;
  generation: number;
  id: TaskId;
  pipelineOptions: RunPipelineOptions;
  step: Extract<NormalizedPipelineStep, { type: 'command' }>;
}): ExecutionTask {
  return {
    failPolicy: 'stop-pipeline',
    generation: options.generation,
    id: options.id,
    invalidatesPreflight: true,
    issueTask: 'command',
    kind: 'command',
    label: getPipelineStepLabel(options.step),
    order: 0,
    resources: {
      exclusive: ['repository:snapshot', 'workspace:manifest', 'stdout'],
    },
    run: async (context) =>
      toExecutionTaskRunResult(
        await runCommandStep(options.config, options.step, {
          ...options.pipelineOptions,
          flow: context.flow,
          preflight: context.preflight,
          progress: context.progress,
          providers: context.preflight.providers,
        }),
      ),
  };
}

export function createMaterializationTask(options: {
  generation: number;
  segment: number;
}): ExecutionTask {
  return {
    failPolicy: 'continue',
    generation: options.generation,
    id: taskId(
      `preparation:graph-materialize:g${options.generation}:s${options.segment}`,
    ),
    issueTask: 'graph:materialize',
    kind: 'preparation',
    label: 'graph:materialize',
    order: 0,
    resources: {
      read: ['repository:snapshot', 'workspace:manifest'],
      write: ['workspace:generated-files'],
    },
    run: async ({ preflight }) => {
      await preflight.ensureGeneratedArtifactsMaterialized();
      return { issues: [], status: 'passed' };
    },
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createWorkspaceValidationFailure(
  config: ResolvedLiminaConfig,
  error: unknown,
) {
  return createTaskFailureIssue({
    code: 'LIMINA_WORKSPACE_VALIDATION_FAILED',
    detailLines: [formatError(error)],
    filePath: config.configPath,
    fix: 'Repair workspace topology, package identities, or output roots, then rerun limina check.',
    reason: 'Workspace validation failed before dependent tasks started.',
    rootDir: config.rootDir,
    task: 'workspace:validate',
    title: 'Workspace validation failed',
  });
}

function getWorkspaceValidationIssues(
  config: ResolvedLiminaConfig,
  error: unknown,
) {
  if (error instanceof LiminaStructuredError) return error.issues;
  return [createWorkspaceValidationFailure(config, error)];
}

export function createWorkspaceValidationTask(options: {
  config: ResolvedLiminaConfig;
  generation: number;
  segment: number;
}): ExecutionTask {
  return {
    failPolicy: 'continue',
    generation: options.generation,
    id: taskId(
      `preparation:workspace-validate:g${options.generation}:s${options.segment}`,
    ),
    issueTask: 'workspace:validate',
    kind: 'preparation',
    label: 'workspace:validate',
    order: 0,
    resources: {
      read: ['repository:snapshot', 'workspace:manifest'],
    },
    run: async ({ preflight }) => {
      try {
        await preflight.ensureWorkspaceValidated();
        return { issues: [], status: 'passed' };
      } catch (error) {
        return {
          issues: getWorkspaceValidationIssues(options.config, error),
          status: 'failed',
        };
      }
    },
  };
}
