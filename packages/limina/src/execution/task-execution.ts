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
import type {
  ExecutionTask,
  ExecutionTaskRunResult,
  StartedTaskResult,
} from './tasks';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createInfrastructureIssue(
  task: ExecutionTask,
  rootDir: string,
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
    rootDir,
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
  const startedAt = performance.now();
  try {
    const result = await options.task.run({
      flow: options.execution.flow,
      preflight: options.execution.preflight,
      progress: createTaskProgressReporter(options.flowNode),
    });
    assertRunnerStatus(result, options.task);
    return { ...result, durationMs: performance.now() - startedAt };
  } catch (error) {
    return {
      durationMs: performance.now() - startedAt,
      issues: normalizeRunnerError({
        error,
        rootDir: options.execution.rootDir,
        task: options.task,
      }),
      status: 'failed',
    };
  }
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
  entry.settlement = gate.promise.then((decision) =>
    settleDecision({ ...options, decision, entry }),
  );
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
