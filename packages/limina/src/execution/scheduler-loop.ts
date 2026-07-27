import {
  canStartTask,
  dependenciesSettled,
  findBlockedDependency,
} from './scheduler-readiness';
import { joinRunning, settleOneRunning } from './scheduler-settlement';
import { finishSynthetic, startTask } from './scheduler-tasks';
import type { SchedulerContext } from './scheduler-types';
import { assertActiveGeneration } from './task-execution';
import type { ExecutionTask } from './tasks';

type TaskAction =
  | 'blocked'
  | 'start'
  | 'wait-dependencies'
  | 'wait-generation'
  | 'wait-resources';

interface TaskActionContext {
  blocker: ReturnType<typeof findBlockedDependency>;
  context: SchedulerContext;
  task: ExecutionTask;
}

interface TaskActionMatcher {
  action: TaskAction;
  matches(options: TaskActionContext): boolean;
}

const taskActionMatchers: readonly TaskActionMatcher[] = [
  {
    action: 'wait-generation',
    matches: ({ context, task }) =>
      task.generation > context.controller.generation,
  },
  {
    action: 'wait-dependencies',
    matches: ({ context, task }) => !dependenciesSettled(task, context),
  },
  {
    action: 'blocked',
    matches: ({ blocker }) => blocker !== undefined,
  },
  {
    action: 'wait-resources',
    matches: ({ context, task }) => !canStartTask({ context, task }),
  },
];

function getTaskAction(options: TaskActionContext): TaskAction {
  const match = taskActionMatchers.find((entry) => entry.matches(options));
  return match === undefined ? 'start' : match.action;
}

async function handleBlocked(options: TaskActionContext): Promise<boolean> {
  await finishSynthetic({
    context: options.context,
    outcome: { blockedBy: options.blocker!, status: 'blocked' },
    task: options.task,
  });
  return true;
}

async function handleStart(options: TaskActionContext): Promise<boolean> {
  assertActiveGeneration(options.task, options.context.controller.generation);
  await startTask({ context: options.context, task: options.task });
  return true;
}

async function handleWait(): Promise<boolean> {
  return false;
}

const taskActionHandlers: Record<
  TaskAction,
  (options: TaskActionContext) => Promise<boolean>
> = {
  blocked: handleBlocked,
  start: handleStart,
  'wait-dependencies': handleWait,
  'wait-generation': handleWait,
  'wait-resources': handleWait,
};

async function processTaskCandidate(options: {
  context: SchedulerContext;
  task: ExecutionTask;
}): Promise<boolean> {
  const actionContext: TaskActionContext = {
    blocker: findBlockedDependency(options),
    ...options,
  };
  return taskActionHandlers[getTaskAction(actionContext)](actionContext);
}

function getPendingTasks(context: SchedulerContext): ExecutionTask[] {
  return [...context.pending.values()].sort(
    (left, right) => left.order - right.order,
  );
}

async function processPendingTasks(
  context: SchedulerContext,
): Promise<boolean> {
  let progressed = false;
  for (const task of getPendingTasks(context)) {
    const taskProgressed = await processTaskCandidate({ context, task });
    progressed = taskProgressed || progressed;
  }
  return progressed;
}

function shouldSettleRunning(options: {
  context: SchedulerContext;
  progressed: boolean;
}): boolean {
  if (options.context.running.size === 0) return false;
  if (!options.progressed) return true;
  return options.context.running.size >= options.context.concurrency;
}

function assertResolvedState(options: {
  context: SchedulerContext;
  progressed: boolean;
}): void {
  const unresolved = [
    !options.progressed,
    options.context.running.size === 0,
    options.context.pending.size > 0,
  ].every(Boolean);
  if (unresolved) {
    throw new Error('Execution scheduler reached an unresolved plan state.');
  }
}

async function advanceGeneration(context: SchedulerContext): Promise<void> {
  await joinRunning(context);
  if (context.infrastructureError !== undefined) return;
  context.controller.startNextGeneration();
  context.pendingGenerationAdvance = false;
}

async function runSchedulerIteration(context: SchedulerContext): Promise<void> {
  if (context.pendingGenerationAdvance) {
    await advanceGeneration(context);
    return;
  }
  const progressed = await processPendingTasks(context);
  if (shouldSettleRunning({ context, progressed })) {
    await settleOneRunning(context);
    return;
  }
  assertResolvedState({ context, progressed });
}

function hasSchedulerWork(context: SchedulerContext): boolean {
  return context.pending.size > 0 || context.running.size > 0;
}

async function runSchedulerLoop(context: SchedulerContext): Promise<void> {
  while (hasSchedulerWork(context)) {
    if (context.infrastructureError !== undefined) return;
    await runSchedulerIteration(context);
  }
}

function setInfrastructureError(
  context: SchedulerContext,
  error: unknown,
): void {
  if (context.infrastructureError === undefined) {
    context.infrastructureError = error;
  }
}

async function finishInfrastructureFailure(
  context: SchedulerContext,
): Promise<void> {
  await joinRunning(context);
  if (context.pendingGenerationAdvance) {
    context.controller.startNextGeneration();
    context.pendingGenerationAdvance = false;
  }
  throw context.infrastructureError;
}

async function finishGenerationAdvance(
  context: SchedulerContext,
): Promise<void> {
  if (!context.pendingGenerationAdvance) return;
  await joinRunning(context);
  context.controller.startNextGeneration();
  context.pendingGenerationAdvance = false;
}

export async function runScheduler(context: SchedulerContext): Promise<void> {
  try {
    await runSchedulerLoop(context);
  } catch (error) {
    setInfrastructureError(context, error);
  }
  if (context.infrastructureError !== undefined) {
    await finishInfrastructureFailure(context);
  }
  await finishGenerationAdvance(context);
}
