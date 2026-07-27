import type { CheckRunRecorder } from '../check-reporting/run-recorder';
import type { LiminaFlowTreeNode } from '../flow';
import type { ExecutionTask, TaskLifecycleEvent } from './tasks';

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatFlowTaskName(task: ExecutionTask): string {
  if (task.kind === 'command') return `command: ${task.label}`;
  return task.label.replaceAll(':', ' ');
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
      elapsedTimeMs: options.event.durationMs,
    });
  }
}

function projectFlowBlock(options: FlowProjectionOptions): void {
  if (options.event.type !== 'block') return;
  if (options.flowNode === undefined) return;
  options.flowNode.block(
    `${formatFlowTaskName(options.task)} (blocked by ${options.event.blockedBy.label})`,
  );
}

function projectFlowSkip(options: FlowProjectionOptions): void {
  if (options.event.type !== 'skip') return;
  if (options.flowNode === undefined) return;
  options.flowNode.skip(
    `${formatFlowTaskName(options.task)} (${options.event.reason})`,
  );
}

const flowProjections: Record<TaskLifecycleEvent['type'], FlowProjection> = {
  block: projectFlowBlock,
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
    if (result.status === 'fulfilled') return [];
    return [result.reason];
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
