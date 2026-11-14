import type { RunningTaskEntry } from './executor-types';
import { observeScheduler } from './scheduler-trace';
import type { SchedulerContext } from './scheduler-types';
import { assertActiveGeneration, createRunningEntry } from './task-execution';
import { ignoreError, nowIso, projectRecorderAndFlow } from './task-observers';
import type {
  ExecutionTask,
  ExecutionTaskOutcome,
  TaskLifecycleEvent,
} from './tasks';

export async function projectLifecycle(options: {
  context: SchedulerContext;
  event: TaskLifecycleEvent;
  task: ExecutionTask;
}): Promise<void> {
  options.context.state.transition(options.task.id, options.event);
  await projectRecorderAndFlow({
    event: options.event,
    flowNode: options.context.flowNodes.get(options.task.id),
    recorder: options.context.options.checkRunRecorder,
    task: options.task,
  });
}

async function cleanupRegisteredStart(options: {
  context: SchedulerContext;
  entry: RunningTaskEntry;
  stateBecameRunning: boolean;
}): Promise<void> {
  if (!options.stateBecameRunning) return;
  const cleanupEvent: TaskLifecycleEvent = {
    completedAt: nowIso(),
    durationMs: 0,
    executionStarted: false,
    reason: 'infrastructure start failure',
    type: 'fail',
  };
  options.context.state.transition(options.entry.task.id, cleanupEvent);
  const cleanup = projectRecorderAndFlow({
    event: cleanupEvent,
    flowNode: options.context.flowNodes.get(options.entry.task.id),
    recorder: options.context.options.checkRunRecorder,
    task: options.entry.task,
  });
  try {
    await cleanup;
  } catch (error) {
    ignoreError(error);
  }
}

async function abortRegisteredStart(options: {
  context: SchedulerContext;
  entry: RunningTaskEntry;
  error: unknown;
  stateBecameRunning: boolean;
}): Promise<void> {
  await cleanupRegisteredStart(options);
  options.entry.gate.resolve({ error: options.error, type: 'abort' });
  await options.entry.settlement;
  options.context.running.delete(options.entry.task.id);
  options.context.locks.release(options.entry.task.id);
  options.context.options.checkRunRecorder?.trace?.released(
    options.entry.task.id,
    'infrastructure-start-failure',
  );
}

export async function startTask(options: {
  context: SchedulerContext;
  task: ExecutionTask;
}): Promise<void> {
  assertActiveGeneration(options.task, options.context.controller.generation);
  options.context.options.checkRunRecorder?.trace?.dispatched(options.task.id);
  options.context.pending.delete(options.task.id);
  options.context.locks.acquire(options.task.id, options.task.resources);
  const entry = createRunningEntry({
    execution: options.context.options,
    flowNode: options.context.flowNodes.get(options.task.id),
    task: options.task,
  });
  options.context.running.set(options.task.id, entry);
  observeScheduler(options.context);
  let isStateBecameRunning = false;
  try {
    const startedAtMonotonic = performance.now();
    const event: TaskLifecycleEvent = {
      startedAt: new Date(
        performance.timeOrigin + startedAtMonotonic,
      ).toISOString(),
      startedAtMonotonic,
      type: 'start',
    };
    options.context.state.transition(options.task.id, event);
    isStateBecameRunning = true;
    await projectRecorderAndFlow({
      event,
      flowNode: options.context.flowNodes.get(options.task.id),
      recorder: options.context.options.checkRunRecorder,
      task: options.task,
    });
    entry.gate.resolve({ type: 'run' });
    observeScheduler(options.context);
  } catch (error) {
    await abortRegisteredStart({
      context: options.context,
      entry,
      error,
      stateBecameRunning: isStateBecameRunning,
    });
    throw error;
  }
}

function assertSkippedCause(options: {
  outcome: Extract<ExecutionTaskOutcome, { status: 'blocked' | 'skipped' }>;
  task: ExecutionTask;
}): void {
  if (
    options.outcome.status !== 'skipped' ||
    options.outcome.causedBy !== undefined
  )
    return;
  throw new Error(
    `Skipped task "${options.task.label}" is missing its root cause.`,
  );
}

function createSyntheticEvent(
  outcome: Extract<ExecutionTaskOutcome, { status: 'blocked' | 'skipped' }>,
): TaskLifecycleEvent {
  return outcome.status === 'blocked'
    ? { blockedBy: outcome.blockedBy, type: 'block' }
    : { reason: outcome.reason, type: 'skip' };
}

export async function finishSynthetic(options: {
  context: SchedulerContext;
  outcome: Extract<ExecutionTaskOutcome, { status: 'blocked' | 'skipped' }>;
  task: ExecutionTask;
}): Promise<void> {
  assertSkippedCause(options);
  options.context.pending.delete(options.task.id);
  options.context.outcomes.set(options.task.id, options.outcome);
  observeScheduler(options.context);
  options.context.options.checkRunRecorder?.trace?.released(
    options.task.id,
    options.outcome.status,
  );
  await projectLifecycle({
    context: options.context,
    event: createSyntheticEvent(options.outcome),
    task: options.task,
  });
}
