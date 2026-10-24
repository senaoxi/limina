import { createPreflightGenerationController } from '../preflight/generation';
import {
  abortCheckAttempt,
  publishCheckAttempt,
} from '../source-check/snapshot/check-attempt-io';
import { resolveTaskConcurrency } from './config';
import {
  collectExecutionIssues,
  createCompletedRunOutcome,
  createExecutionResult,
  selectSourceOutcome,
} from './execution-results';
import { writeSnapshotsPreservingFailure } from './execution-snapshots';
import type {
  RunExecutionPlanOptions,
  RunExecutionResult,
  RunExecutionTasksOptions,
} from './executor-types';
import { validateExecutionPlan } from './plan-validation';
import { ResourceLockSet } from './resources';
import { runScheduler } from './scheduler-loop';
import type { SchedulerContext } from './scheduler-types';
import { ExecutionStateStore } from './state-store';
import { formatFlowTaskName } from './task-observers';
import type {
  CompletedRunOutcome,
  ExecutionPlan,
  ExecutionTask,
} from './tasks';

export {
  createCompletedRunOutcome,
  resolveRootBlocker,
} from './execution-results';
export type * from './executor-types';
export { validateExecutionPlan } from './plan-validation';

export function runExecutionPlan(
  plan: ExecutionPlan,
  options: RunExecutionPlanOptions,
): Promise<RunExecutionResult> {
  const controller = createPreflightGenerationController(options.preflight);
  return runExecutionPlanWithController(plan, options, controller);
}

export function runExecutionTasks(
  options: RunExecutionTasksOptions,
): ReturnType<typeof runExecutionPlan> {
  return runExecutionPlan(
    { tasks: options.tasks, userTaskCount: options.tasks.length },
    options,
  );
}

function resolveConcurrency(options: {
  execution: RunExecutionPlanOptions;
  taskCount: number;
}): number {
  return Math.max(
    1,
    resolveTaskConcurrency({
      config: options.execution.preflight.config,
      itemCount: options.taskCount,
    }),
  );
}

function createFlowNodes(options: {
  execution: RunExecutionPlanOptions;
  tasks: readonly ExecutionTask[];
}) {
  const nodes: SchedulerContext['flowNodes'] = new Map();
  if (options.execution.flow === undefined) return nodes;
  for (const task of options.tasks) {
    nodes.set(
      task.id,
      options.execution.flow.tree(formatFlowTaskName(task), { depth: 1 }),
    );
  }
  return nodes;
}

function createSchedulerContext(
  plan: ExecutionPlan,
  execution: RunExecutionPlanOptions,
  controller: SchedulerContext['controller'],
): SchedulerContext {
  const orderedTasks = [...plan.tasks].sort(
    (left, right) => left.order - right.order,
  );
  return {
    concurrency: resolveConcurrency({
      execution,
      taskCount: orderedTasks.length,
    }),
    controller,
    flowNodes: createFlowNodes({ execution, tasks: orderedTasks }),
    infrastructureError: undefined,
    locks: new ResourceLockSet(),
    options: execution,
    orderedTasks,
    outcomes: new Map(),
    pending: new Map(orderedTasks.map((task) => [task.id, task])),
    pendingGenerationAdvance: false,
    running: new Map(),
    state: new ExecutionStateStore(orderedTasks),
  };
}

function ignoreError(error: unknown): void {
  String(error);
}

function finishCheckRecording(
  recorder: RunExecutionPlanOptions['checkRunRecorder'],
  outcome: CompletedRunOutcome,
): void {
  recorder?.finish(outcome);
}

async function runExecutionPlanWithController(
  plan: ExecutionPlan,
  options: RunExecutionPlanOptions,
  controller: SchedulerContext['controller'],
): Promise<RunExecutionResult> {
  validateExecutionPlan(plan);
  const attempt = await publishCheckAttempt({
    command: options.command,
    namespace: options.preflight.artifactNamespace,
  });
  const execution = await (async () => {
    try {
      const context = createSchedulerContext(plan, options, controller);
      await runScheduler(context);
      await options.preflight.publishAnalysisCache();
      const completedOutcome = createCompletedRunOutcome(
        context.orderedTasks,
        context.outcomes,
      );
      context.state.finish(completedOutcome);
      finishCheckRecording(options.checkRunRecorder, completedOutcome);
      const issues = collectExecutionIssues({
        orderedTasks: context.orderedTasks,
        outcomes: context.outcomes,
        rootDir: options.rootDir,
      });
      const source = selectSourceOutcome({
        orderedTasks: context.orderedTasks,
        outcomes: context.outcomes,
      });
      return { completedOutcome, context, issues, source };
    } catch (error) {
      try {
        await abortCheckAttempt({
          attempt,
          error,
          namespace: options.preflight.artifactNamespace,
        });
      } catch (cleanupError) {
        ignoreError(cleanupError);
      }
      throw error;
    }
  })();
  await writeSnapshotsPreservingFailure({
    attempt,
    completedState: execution.completedOutcome.state,
    execution: options,
    finalRepositoryGeneration: execution.context.controller.generation,
    issues: execution.issues,
    sourceOutcome: execution.source.sourceOutcome,
    sourceTask: execution.source.sourceTask,
    tasks: execution.context.orderedTasks,
  });
  return createExecutionResult({
    issues: execution.issues,
    orderedTasks: execution.context.orderedTasks,
    outcome: execution.completedOutcome,
    outcomes: execution.context.outcomes,
  });
}
