import type { RunningTaskEntry } from './executor-types';
import { finishSynthetic, projectLifecycle } from './scheduler-tasks';
import { observeScheduler } from './scheduler-trace';
import type { SchedulerContext } from './scheduler-types';
import { nowIso } from './task-observers';
import type {
  ExecutionTask,
  StartedTaskResult,
  TaskLifecycleEvent,
} from './tasks';
import { taskReference } from './tasks';

function createCompletionEvent(options: {
  outcome: StartedTaskResult;
  task: ExecutionTask;
}): TaskLifecycleEvent {
  const completedAt = options.outcome.timing?.completedAt ?? nowIso();
  const startedAt = options.outcome.timing?.startedAt;
  if (options.outcome.status === 'disabled') {
    return {
      completedAt,
      startedAt,
      durationMs: options.outcome.durationMs,
      type: 'disable',
    };
  }
  if (options.outcome.status === 'passed') {
    return {
      completedAt,
      startedAt,
      durationMs: options.outcome.durationMs,
      stats: options.outcome.stats,
      type: 'pass',
    };
  }
  return {
    completedAt,
    startedAt,
    durationMs: options.outcome.durationMs,
    reason: `${options.task.label} failed`,
    stats: options.outcome.stats,
    type: 'fail',
  };
}

export async function stopRemaining(options: {
  blocker: ExecutionTask;
  context: SchedulerContext;
}): Promise<void> {
  const remaining = options.context.pending
    .values()
    .filter((task) => task.order > options.blocker.order)
    .toArray()
    .sort((left, right) => left.order - right.order);
  for (const task of remaining) {
    await finishSynthetic({
      context: options.context,
      outcome: {
        causedBy: taskReference(options.blocker),
        reason: `skipped after "${options.blocker.label}" failed`,
        status: 'skipped',
      },
      task,
    });
  }
}

function shouldStopPipeline(options: {
  outcome: StartedTaskResult;
  task: ExecutionTask;
}): boolean {
  return (
    options.outcome.status === 'failed' &&
    options.task.failPolicy === 'stop-pipeline'
  );
}

function markGenerationAdvance(options: {
  context: SchedulerContext;
  task: ExecutionTask;
}): void {
  if (options.task.invalidatesPreflight) {
    options.context.pendingGenerationAdvance = true;
  }
}

function reportTaskStats(options: {
  context: SchedulerContext;
  outcome: StartedTaskResult;
  task: ExecutionTask;
}): void {
  const observer = options.context.options.onTaskStats;
  if (observer !== undefined) observer(options.task, options.outcome.stats);
}

async function stopPipelineIfNeeded(options: {
  context: SchedulerContext;
  outcome: StartedTaskResult;
  task: ExecutionTask;
}): Promise<void> {
  if (!shouldStopPipeline(options)) return;
  await stopRemaining({ blocker: options.task, context: options.context });
}

async function processTaskSettlement(options: {
  context: SchedulerContext;
  entry: RunningTaskEntry;
  outcome: StartedTaskResult;
}): Promise<void> {
  const task = options.entry.task;
  options.context.outcomes.set(task.id, options.outcome);
  observeScheduler(options.context);
  markGenerationAdvance({ context: options.context, task });
  await projectLifecycle({
    context: options.context,
    event: createCompletionEvent({ outcome: options.outcome, task }),
    task,
  });
  reportTaskStats({ context: options.context, outcome: options.outcome, task });
  await stopPipelineIfNeeded({
    context: options.context,
    outcome: options.outcome,
    task,
  });
}

export async function settleEntry(options: {
  context: SchedulerContext;
  entry: RunningTaskEntry;
}): Promise<void> {
  const settlement = await options.entry.settlement;
  options.context.options.checkRunRecorder?.trace?.settlementStarted(
    options.entry.task.id,
  );
  try {
    if (settlement.type === 'infrastructure-start-failure') return;
    await processTaskSettlement({
      context: options.context,
      entry: options.entry,
      outcome: settlement.outcome,
    });
  } finally {
    options.context.running.delete(options.entry.task.id);
    options.context.locks.release(options.entry.task.id);
    observeScheduler(options.context);
    options.context.options.checkRunRecorder?.trace?.released(
      options.entry.task.id,
      settlement.type === 'task'
        ? settlement.outcome.status
        : 'infrastructure-start-failure',
    );
  }
}

async function firstSettledEntry(
  running: ReadonlyMap<string, RunningTaskEntry>,
): Promise<RunningTaskEntry> {
  return Promise.race(
    running.values().map(async (candidate) => {
      await candidate.settlement;
      return candidate;
    }),
  );
}

export async function settleOneRunning(
  context: SchedulerContext,
): Promise<void> {
  const entry = await firstSettledEntry(context.running);
  await settleEntry({ context, entry });
}

function recordInfrastructureError(
  context: SchedulerContext,
  error: unknown,
): void {
  if (context.infrastructureError === undefined) {
    context.infrastructureError = error;
  }
}

async function settleCapturingError(
  context: SchedulerContext,
  entry: RunningTaskEntry,
): Promise<void> {
  try {
    await settleEntry({ context, entry });
  } catch (error) {
    recordInfrastructureError(context, error);
  }
}

export async function joinRunning(context: SchedulerContext): Promise<void> {
  while (context.running.size > 0) {
    const entry = await firstSettledEntry(context.running);
    await settleCapturingError(context, entry);
  }
}
