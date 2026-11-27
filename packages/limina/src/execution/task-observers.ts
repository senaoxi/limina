import type { AnalysisObserver } from '../application/analysis/observability';
import type { LiminaFlowTreeNode } from '../flow';
import type { CheckRunRecorder } from './run-recorder';
import type { ExecutionTask, TaskLifecycleEvent } from './tasks';

export function nowIso(): string {
  return new Date(performance.timeOrigin + performance.now()).toISOString();
}

export function formatFlowTaskName(task: ExecutionTask): string {
  if (task.issueTask === 'graph:materialize') {
    return 'prepare reference graph';
  }
  return task.kind === 'command'
    ? `command: ${task.label}`
    : task.label.replaceAll(':', ' ');
}

interface FlowProjectionOptions {
  event: TaskLifecycleEvent;
  flowNode: LiminaFlowTreeNode | undefined;
  task: ExecutionTask;
}

type FlowProjection = (options: FlowProjectionOptions) => void;

function projectFlowStart(options: FlowProjectionOptions): void {
  if (options.flowNode !== undefined) options.flowNode.start();
}

function projectFlowPass(options: FlowProjectionOptions): void {
  if (options.event.type !== 'pass') return;
  if (options.flowNode !== undefined) {
    options.flowNode.pass(undefined, {
      elapsedTimeMs: options.event.durationMs,
    });
  }
}

function projectFlowFail(options: FlowProjectionOptions): void {
  if (options.event.type !== 'fail') return;
  if (options.flowNode !== undefined) {
    options.flowNode.fail(undefined, {
      elapsedTimeMs:
        options.event.executionStarted === false
          ? null
          : options.event.durationMs,
    });
  }
}

function projectFlowDisable(options: FlowProjectionOptions): void {
  if (options.event.type !== 'disable') return;
  const { task } = options;
  const detail =
    task.kind === 'task' && task.label === 'checker:typecheck'
      ? 'disabled: no framework targets'
      : 'disabled';
  options.flowNode?.skip(`${formatFlowTaskName(task)} (${detail})`);
}

function projectFlowBlock(options: FlowProjectionOptions): void {
  if (options.event.type !== 'block' || options.flowNode === undefined) return;
  options.flowNode.block(
    `${formatFlowTaskName(options.task)} (blocked by ${options.event.blockedBy.label})`,
  );
}

function projectFlowSkip(options: FlowProjectionOptions): void {
  if (options.event.type !== 'skip' || options.flowNode === undefined) return;
  options.flowNode.skip(
    `${formatFlowTaskName(options.task)} (${options.event.reason})`,
  );
}

const flowProjections: Record<TaskLifecycleEvent['type'], FlowProjection> = {
  block: projectFlowBlock,
  disable: projectFlowDisable,
  fail: projectFlowFail,
  pass: projectFlowPass,
  skip: projectFlowSkip,
  start: projectFlowStart,
};

function projectFlow(options: FlowProjectionOptions): void {
  flowProjections[options.event.type](options);
}

function collectProjectionFailures(
  settled: readonly PromiseSettledResult<void>[],
): unknown[] {
  return settled.flatMap((result) => {
    return result.status === 'fulfilled' ? [] : [result.reason];
  });
}

function attachSecondaryProjectionErrors(options: {
  failures: readonly unknown[];
  primary: Error;
}): void {
  if (options.failures.length <= 1) return;
  Object.defineProperty(options.primary, 'secondaryProjectionErrors', {
    configurable: true,
    value: options.failures.slice(1),
  });
}

function throwProjectionFailures(failures: readonly unknown[]): void {
  if (failures.length === 0) return;
  const primary = failures[0];
  if (primary instanceof Error) {
    attachSecondaryProjectionErrors({ failures, primary });
  }
  throw primary;
}

export async function projectRecorderAndFlow(options: {
  event: TaskLifecycleEvent;
  flowNode: LiminaFlowTreeNode | undefined;
  recorder: CheckRunRecorder | undefined;
  task: ExecutionTask;
}): Promise<void> {
  const settled = await Promise.allSettled([
    Promise.resolve(options.recorder?.project(options.task, options.event)),
    Promise.resolve(projectFlow(options)),
  ]);
  throwProjectionFailures(collectProjectionFailures(settled));
}

export function ignoreError(error: unknown): void {
  String(error);
}
export async function runObservedTask<T>(options: {
  observer: AnalysisObserver;
  operation: 'execution.standalone-action' | 'execution.task-runner';
  taskId: string;
  execute: () => Promise<T>;
  isPassed: (value: T) => boolean;
  failureDetail?: (value: T) => unknown;
}): Promise<T> {
  const { observer, execute } = options;
  let work: string;
  try {
    work = observer.start(options.operation, ['task', options.taskId]);
  } catch {
    return execute();
  }
  let hasEnteredRunner = false;
  let outcome: 'performed' | 'failed' | 'cancelled' = 'failed';
  let observedResult: T | undefined;
  let runnerError: unknown;
  try {
    const result = await observer.inWork(work, () => {
      hasEnteredRunner = true;
      return execute();
    });
    outcome = options.isPassed(result) ? 'performed' : 'failed';
    observedResult = result;
    return result;
  } catch (error) {
    if (hasEnteredRunner) {
      runnerError = error;
      throw error;
    }
    outcome = 'cancelled';
    return execute();
  } finally {
    try {
      if (outcome === 'failed') {
        const detail =
          runnerError ??
          (observedResult === undefined
            ? undefined
            : options.failureDetail?.(observedResult));
        observer.fail(work, detail);
      } else {
        observer.finish(
          work,
          outcome,
          outcome === 'cancelled' ? 'profile-scope-unavailable' : undefined,
        );
      }
    } catch {
      // Profiling does not own the task outcome.
    }
  }
}
