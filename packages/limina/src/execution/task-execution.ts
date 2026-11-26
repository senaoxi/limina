import { currentProfile } from '../application/analysis/observability';
import { LiminaStructuredError } from '../check-reporting/errors';
import type { LiminaCheckIssue } from '../check-reporting/snapshot';
import { createTaskFailureIssue } from '../check-reporting/snapshot';
import type { LiminaFlowTreeNode } from '../flow';
import type {
  RunExecutionPlanOptions,
  RunningTaskEntry,
  StartDecision,
} from './executor-types';
import { createTaskProgressReporter } from './progress';
import { runObservedTask } from './task-observers';
import type {
  ExecutionTask,
  ExecutionTaskRunResult,
  StartedTaskResult,
} from './tasks';

const MIN_UNREPORTED_WALL_TIME_MS = 100;

function reportTimeOutsidePhases(options: {
  completedAt: number;
  flowNode: LiminaFlowTreeNode | undefined;
  startedAt: number;
}): void {
  const { flowNode, startedAt, completedAt } = options;
  if (flowNode === undefined) return;
  try {
    const elapsedTimeMs = flowNode.getElapsedOutsideChildren({
      completedAt,
      startedAt,
    });
    if (
      elapsedTimeMs === undefined ||
      elapsedTimeMs < MIN_UNREPORTED_WALL_TIME_MS
    )
      return;

    flowNode
      .child('outside reported phases')
      .pass(undefined, { elapsedTimeMs });
  } catch {
    // The task has already completed even if this row cannot be written.
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  return Promise.withResolvers<T>();
}

function createInfrastructureIssue(
  task: ExecutionTask,
  rootDirectory: string,
  error: unknown,
): LiminaCheckIssue {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    task.issueTask === 'graph:materialize'
      ? 'LIMINA_GRAPH_MATERIALIZE_FAILED'
      : undefined;
  return createTaskFailureIssue({
    code,
    detailLines: [message],
    fix: `Inspect the ${task.issueTask} failure, then rerun limina check.`,
    reason: `${task.issueTask} failed: ${message}.`,
    rootDir: rootDirectory,
    task: task.issueTask,
    title: `${task.issueTask} failed`,
  });
}

function normalizeRunnerError(options: {
  error: unknown;
  rootDir: string;
  task: ExecutionTask;
}): LiminaCheckIssue[] {
  if (options.error instanceof LiminaStructuredError) {
    return options.error.issues;
  }
  return [
    createInfrastructureIssue(options.task, options.rootDir, options.error),
  ];
}

function assertRunnerStatus(
  result: ExecutionTaskRunResult,
  task: ExecutionTask,
): void {
  const runnerStatuses = new Set(['disabled', 'failed', 'passed']);
  if (runnerStatuses.has(result.status)) return;
  throw new Error(
    `Task runner "${task.label}" returned scheduler-owned status.`,
  );
}

export async function normalizeRunnerResult(options: {
  execution: RunExecutionPlanOptions;
  flowNode: LiminaFlowTreeNode | undefined;
  task: ExecutionTask;
}): Promise<StartedTaskResult> {
  const context = {
    flow: options.execution.flow,
    preflight: options.execution.preflight,
    progress: createTaskProgressReporter(options.flowNode),
  };
  const trace = options.execution.checkRunRecorder?.trace;
  let runnerInterval: readonly [number, number] | undefined;
  const execute = async () => {
    const startedAt = performance.now();
    trace?.runnerStarted(options.task.id, startedAt);
    try {
      return await options.task.run(context);
    } finally {
      const completedAt = performance.now();
      trace?.runnerCompleted(options.task.id, completedAt);
      runnerInterval = [startedAt, completedAt];
    }
  };
  const observer = currentProfile();
  const profileId =
    observer === undefined ? undefined : trace?.profileTaskId(options.task.id);
  let result: ExecutionTaskRunResult;
  try {
    result = await (observer === undefined || profileId === undefined
      ? execute()
      : runObservedTask({
          observer,
          operation: 'execution.task-runner',
          taskId: profileId,
          execute,
          isPassed: (value) =>
            value.status === 'disabled' || value.status === 'passed',
          failureDetail: ({ issues }) => {
            const [issue] = issues;
            return (
              issue?.detailLines?.join('\n') || issue?.reason || issue?.code
            );
          },
        }));
    assertRunnerStatus(result, options.task);
  } catch (error) {
    result = {
      issues: normalizeRunnerError({
        error,
        rootDir: options.execution.rootDir,
        task: options.task,
      }),
      status: 'failed',
    };
  }
  if (runnerInterval === undefined) return { ...result, durationMs: 0 };
  const [startedAt, completedAt] = runnerInterval;
  if (result.status !== 'disabled')
    reportTimeOutsidePhases({
      completedAt,
      flowNode: options.flowNode,
      startedAt,
    });
  return {
    ...result,
    durationMs: completedAt - startedAt,
    timing: {
      startedAt: new Date(performance.timeOrigin + startedAt).toISOString(),
      completedAt: new Date(performance.timeOrigin + completedAt).toISOString(),
    },
  };
}

async function settleDecision(options: {
  decision: StartDecision;
  entry: RunningTaskEntry;
  execution: RunExecutionPlanOptions;
  flowNode: LiminaFlowTreeNode | undefined;
}) {
  if (options.decision.type === 'abort') {
    return {
      error: options.decision.error,
      type: 'infrastructure-start-failure' as const,
    };
  }
  options.entry.executionStarted = true;
  return {
    outcome: await normalizeRunnerResult({
      execution: options.execution,
      flowNode: options.flowNode,
      task: options.entry.task,
    }),
    type: 'task' as const,
  };
}

export function createRunningEntry(options: {
  execution: RunExecutionPlanOptions;
  flowNode: LiminaFlowTreeNode | undefined;
  task: ExecutionTask;
}): RunningTaskEntry {
  const gate = createDeferred<StartDecision>();
  const entry: RunningTaskEntry = {
    executionStarted: false,
    gate,
    locks: options.task.resources,
    settlement: Promise.resolve(undefined as never),
    task: options.task,
  };
  entry.settlement = (async () => {
    const decision = await gate.promise;
    return settleDecision({ ...options, decision, entry });
  })();
  return entry;
}

export function assertActiveGeneration(
  task: ExecutionTask,
  activeGeneration: number,
): void {
  if (task.generation === activeGeneration) return;
  throw new Error(
    `Execution task "${task.label}" belongs to generation ${task.generation}, but the active repository generation is ${activeGeneration}.`,
  );
}
