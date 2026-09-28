import { transitionTask } from '../execution/state-store';
import type {
  CompletedRunOutcome,
  ExecutionTaskIdentity,
  TaskLifecycleEvent,
} from '../execution/tasks';
import type { LiminaCheckRunTaskStats } from './run-recorder-types';
import type {
  LiminaCheckRunCheckItemSummary,
  LiminaCheckRunSummary,
  LiminaCheckRunTaskSummary,
} from './snapshot';

export interface RecorderState {
  run: LiminaCheckRunSummary;
  taskById: ReadonlyMap<ExecutionTaskIdentity['id'], LiminaCheckRunTaskSummary>;
}

interface TaskProjectionContext {
  nextState: LiminaCheckRunTaskSummary['state'];
  run: LiminaCheckRunSummary;
  task: LiminaCheckRunTaskSummary;
}

type EventType = TaskLifecycleEvent['type'];
type EventFor<Type extends EventType> = Extract<
  TaskLifecycleEvent,
  { type: Type }
>;
type TaskEventProjector = (
  context: TaskProjectionContext,
  event: TaskLifecycleEvent,
) => void;

function cloneOptionalObject<Value extends object>(
  value: Value | undefined,
): Value | undefined {
  return value === undefined ? undefined : { ...value };
}

function cloneOptionalObjects<Value extends object>(
  values: readonly Value[] | undefined,
): Value[] | undefined {
  return values === undefined
    ? undefined
    : values.map((value) => ({ ...value }));
}

function cloneCheckItem(
  item: LiminaCheckRunCheckItemSummary,
): LiminaCheckRunCheckItemSummary {
  if (item.itemKind !== 'checker-target') {
    return { ...item };
  }

  return {
    ...item,
    blockedBy: cloneOptionalObjects(item.blockedBy),
  };
}

function cloneTaskSummary(
  task: LiminaCheckRunTaskSummary,
): LiminaCheckRunTaskSummary {
  return {
    ...task,
    blockedBy: cloneOptionalObject(task.blockedBy),
    checkItems: task.checkItems?.map(cloneCheckItem),
  };
}

export function cloneRun(run: LiminaCheckRunSummary): LiminaCheckRunSummary {
  return {
    ...run,
    blockedBy: cloneOptionalObject(run.blockedBy),
    tasks: run.tasks.map(cloneTaskSummary),
  };
}

function durationBetween(
  startedAt: string | undefined,
  completedAt: string,
): number | undefined {
  if (startedAt === undefined) {
    return undefined;
  }

  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

function normalizeOptionalNumber(
  value: number | undefined,
): number | undefined {
  return value === undefined ? undefined : Math.max(0, value);
}

function normalizeCheckItem(
  item: LiminaCheckRunCheckItemSummary,
): LiminaCheckRunCheckItemSummary {
  const normalizedStatistics = {
    checksPassed: normalizeOptionalNumber(item.checksPassed),
    checksTotal: normalizeOptionalNumber(item.checksTotal),
    durationMs: normalizeOptionalNumber(item.durationMs),
    issues: normalizeOptionalNumber(item.issues),
  };

  if (item.itemKind === 'checker-target') {
    return {
      ...item,
      ...normalizedStatistics,
      blockedBy: cloneOptionalObjects(item.blockedBy),
    };
  }

  return {
    ...item,
    ...normalizedStatistics,
  };
}

function applyTaskStats(
  task: LiminaCheckRunTaskSummary,
  stats: LiminaCheckRunTaskStats | undefined,
): void {
  if (stats === undefined) {
    return;
  }

  task.checksPassed = Math.max(0, stats.passed);
  task.checksTotal = Math.max(0, stats.total);
  task.checkItems = stats.items?.map(normalizeCheckItem);
}

function taskIdentityMatches(
  task: LiminaCheckRunTaskSummary,
  identity: ExecutionTaskIdentity,
): boolean {
  const comparisons = [
    task.label === identity.label,
    task.kind === identity.kind,
    task.issueTask === identity.issueTask,
    task.generation === identity.generation,
  ];

  return comparisons.every(Boolean);
}

function getTask(
  state: RecorderState,
  identity: ExecutionTaskIdentity,
): LiminaCheckRunTaskSummary {
  const task = state.taskById.get(identity.id);

  if (task === undefined) {
    throw new Error(`Recorder received unknown task id: ${identity.id}.`);
  }

  if (!taskIdentityMatches(task, identity)) {
    throw new Error(`Recorder task identity mismatch for id: ${identity.id}.`);
  }

  return task;
}

function requireEvent<Type extends EventType>(
  event: TaskLifecycleEvent,
  type: Type,
): EventFor<Type> {
  if (event.type !== type) {
    throw new Error(`Unexpected task lifecycle event: ${event.type}.`);
  }

  return event as EventFor<Type>;
}

function applyStartEvent(
  context: TaskProjectionContext,
  rawEvent: TaskLifecycleEvent,
): void {
  const event = requireEvent(rawEvent, 'start');
  context.run.startedAt ??= event.startedAt;
  context.run.result = 'running';
  context.task.startedAt = event.startedAt;
  context.task.state = context.nextState;
}

function applyPassEvent(
  context: TaskProjectionContext,
  rawEvent: TaskLifecycleEvent,
): void {
  const event = requireEvent(rawEvent, 'pass');
  context.task.completedAt = event.completedAt;
  context.task.durationMs = event.durationMs;
  context.task.state = context.nextState;
  applyTaskStats(context.task, event.stats);
}

function applyFailEvent(
  context: TaskProjectionContext,
  rawEvent: TaskLifecycleEvent,
): void {
  const event = requireEvent(rawEvent, 'fail');
  context.task.completedAt = event.completedAt;
  context.task.durationMs = event.durationMs;
  context.task.reason = event.reason;
  context.task.state = context.nextState;
  applyTaskStats(context.task, event.stats);
}

function applyDisableEvent(
  context: TaskProjectionContext,
  rawEvent: TaskLifecycleEvent,
): void {
  const event = requireEvent(rawEvent, 'disable');
  context.task.completedAt = event.completedAt;
  context.task.durationMs = event.durationMs;
  context.task.state = context.nextState;
}

function applyBlockEvent(
  context: TaskProjectionContext,
  rawEvent: TaskLifecycleEvent,
): void {
  const event = requireEvent(rawEvent, 'block');
  context.task.blockedBy = { ...event.blockedBy };
  context.task.state = context.nextState;
}

function applySkipEvent(
  context: TaskProjectionContext,
  rawEvent: TaskLifecycleEvent,
): void {
  const event = requireEvent(rawEvent, 'skip');
  context.task.reason = event.reason;
  context.task.state = context.nextState;
}

const taskEventProjectors: Readonly<Record<EventType, TaskEventProjector>> = {
  block: applyBlockEvent,
  disable: applyDisableEvent,
  fail: applyFailEvent,
  pass: applyPassEvent,
  skip: applySkipEvent,
  start: applyStartEvent,
};

export function projectTask(
  state: RecorderState,
  identity: ExecutionTaskIdentity,
  event: TaskLifecycleEvent,
): void {
  const task = getTask(state, identity);
  const context: TaskProjectionContext = {
    nextState: transitionTask(task.state, event),
    run: state.run,
    task,
  };

  taskEventProjectors[event.type](context, event);
}

function getOutcomeBlocker(
  outcome: CompletedRunOutcome,
): LiminaCheckRunSummary['blockedBy'] {
  if (outcome.state !== 'blocked') {
    return undefined;
  }

  return cloneOptionalObject(outcome.blocker);
}

export function finishRun(
  state: RecorderState,
  outcome: CompletedRunOutcome,
  completedAt: string,
): void {
  state.run.completedAt = completedAt;
  state.run.durationMs = durationBetween(state.run.startedAt, completedAt);
  state.run.result = outcome.state;
  state.run.blockedBy = getOutcomeBlocker(outcome);
}
