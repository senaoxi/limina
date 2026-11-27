import type { ResolvedLiminaConfig } from '#config/runner';
import type {
  CoreAnalysisPhase,
  CoreAnalysisPhaseHandle,
  CoreAnalysisPhaseObserver,
} from '#core';
import { LiminaStructuredError } from '../check-reporting/errors';
import { measureGraphMaterialization } from '../execution/graph-materialization-progress';
import {
  measureTaskProgress,
  startTaskProgressTiming,
  type TaskProgressReporter,
} from '../execution/progress';
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

function toExecutionTaskRunResult(
  result: BuiltinTaskResult,
): ExecutionTaskRunResult {
  return {
    issues: result.issues,
    sourceSnapshot: result.sourceSnapshot,
    stats: result.stats,
    status: result.disabled ? 'disabled' : result.passed ? 'passed' : 'failed',
  };
}

const pinnedProviderTasks = new Set<string>([
  'graph:check',
  'proof:check',
  'source:check',
]);

export function createBuiltinExecutionTask(options: {
  config: ResolvedLiminaConfig;
  generation: number;
  id: TaskId;
  pipelineOptions: RunPipelineOptions;
  step: Extract<NormalizedPipelineStep, { type: 'task' }>;
}): ExecutionTask {
  const shouldPinProviders = pinnedProviderTasks.has(options.step.name);
  return {
    failPolicy: 'continue',
    generation: options.generation,
    id: options.id,
    issueTask: options.step.name,
    kind: 'task',
    label: getPipelineStepLabel(options.step),
    order: 0,
    resources: getBuiltinTaskResources(options.step.name),
    run: async (context) => {
      const releaseProviders = shouldPinProviders
        ? context.preflight.retainActiveProviders()
        : undefined;
      const pinnedProviders = context.preflight.providers;
      const pinnedGraph = shouldPinProviders
        ? context.preflight.getMaterializedGraph()
        : undefined;
      try {
        return toExecutionTaskRunResult(
          await runBuiltinTask(options.config, options.step.name, {
            ...options.pipelineOptions,
            flow: context.flow,
            generatedGraphProvider: () =>
              pinnedGraph === undefined
                ? context.preflight.ensureGeneratedGraph()
                : Promise.resolve(pinnedGraph),
            preflight: context.preflight,
            progress: context.progress,
            providers: pinnedProviders,
          }),
        );
      } finally {
        releaseProviders?.();
      }
    },
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

const coreAnalysisPhaseLabels: Record<CoreAnalysisPhase, string> = {
  'dependency-analysis': 'analyze workspace dependencies',
  'ownership-discovery': 'discover checker ownership',
  'ownership-finalization': 'finalize checker ownership',
};

function createCoreAnalysisPhaseObserver(
  progress: TaskProgressReporter | undefined,
): CoreAnalysisPhaseObserver | undefined {
  return progress === undefined
    ? undefined
    : (phase) => {
        let handle: CoreAnalysisPhaseHandle | undefined;
        try {
          const item = progress.planItem(coreAnalysisPhaseLabels[phase]);
          const finish = startTaskProgressTiming(item, performance.now());
          if (finish !== undefined) {
            handle = {
              fail: () => {
                try {
                  finish('fail');
                } catch {
                  // Flow reporting does not own the task outcome.
                }
              },
              pass: () => {
                try {
                  finish('pass');
                } catch {
                  // Flow reporting does not own the task outcome.
                }
              },
            };
          }
        } catch {
          // Flow reporting does not own the task outcome.
        }
        return handle;
      };
}

function createCoreAnalysisFailure(
  config: ResolvedLiminaConfig,
  error: unknown,
) {
  return createTaskFailureIssue({
    code: 'LIMINA_CORE_ANALYZE_FAILED',
    detailLines: [formatError(error)],
    filePath: config.configPath,
    fix: 'Inspect the core analysis failure, then rerun limina check.',
    reason:
      'Core semantic and dependency analysis failed before reference graph preparation started.',
    rootDir: config.rootDir,
    task: 'core:analyze',
    title: 'Core analysis failed',
  });
}

function getCoreAnalysisIssues(config: ResolvedLiminaConfig, error: unknown) {
  return error instanceof LiminaStructuredError
    ? error.issues
    : [createCoreAnalysisFailure(config, error)];
}

export function createCoreAnalysisTask(options: {
  config: ResolvedLiminaConfig;
  generation: number;
  segment: number;
}): ExecutionTask {
  return {
    failPolicy: 'continue',
    generation: options.generation,
    id: taskId(
      `preparation:core-analyze:g${options.generation}:s${options.segment}`,
    ),
    issueTask: 'core:analyze',
    kind: 'preparation',
    label: 'core:analyze',
    order: 0,
    resources: {
      read: ['repository:snapshot', 'workspace:manifest'],
    },
    run: async ({ preflight, progress }) => {
      try {
        await preflight.ensureCoreAnalysisPrepared({
          onPhase: createCoreAnalysisPhaseObserver(progress),
        });
        return { issues: [], status: 'passed' };
      } catch (error) {
        return {
          issues: getCoreAnalysisIssues(options.config, error),
          status: 'failed',
        };
      }
    },
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
    run: async ({ preflight, progress }) => {
      if (preflight.hasProducerReceipt()) {
        await measureTaskProgress(
          progress,
          'validate Svelte producer receipt',
          () => preflight.assertProducerReceiptCurrent(),
        );
        await measureGraphMaterialization({
          materialize: (onAccess) =>
            preflight.ensureGeneratedArtifactsMaterialized(onAccess),
          progress,
          purpose: 'complete',
        });
        return { issues: [], status: 'passed' };
      }
      const hasSvelte = await preflight.hasSvelteCheckProjects();
      const purpose = hasSvelte ? 'producer-build' : 'complete';
      await measureGraphMaterialization({
        materialize: (onAccess) =>
          purpose === 'complete'
            ? preflight.ensureGeneratedArtifactsMaterialized(onAccess)
            : preflight.ensureExecutionArtifactsMaterialized(
                'producer-build',
                onAccess,
              ),
        progress,
        purpose,
      });
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
  return error instanceof LiminaStructuredError
    ? error.issues
    : [createWorkspaceValidationFailure(config, error)];
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
