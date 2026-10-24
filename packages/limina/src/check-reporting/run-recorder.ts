import { transitionTask } from '../execution/state-store';
import type {
  CompletedRunOutcome,
  ExecutionTaskIdentity,
  TaskLifecycleEvent,
  TaskReference,
} from '../execution/tasks';
import type {
  LiminaCheckRunCheckItemSummary,
  LiminaCheckRunSummary,
  LiminaCheckRunTaskSummary,
} from './snapshot';

export interface LiminaCheckRunTaskStats {
  items?: readonly LiminaCheckRunCheckItemSummary[];
  passed: number;
  total: number;
}

interface RecorderState {
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

function cloneRun(run: LiminaCheckRunSummary): LiminaCheckRunSummary {
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
  return startedAt === undefined
    ? undefined
    : Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
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

function isTaskIdentityMatches(
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

  if (!isTaskIdentityMatches(task, identity)) {
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

function projectTask(
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
  return outcome.state === 'blocked'
    ? cloneOptionalObject(outcome.blocker)
    : undefined;
}

function finishRun(
  state: RecorderState,
  outcome: CompletedRunOutcome,
  completedAt: string,
): void {
  state.run.completedAt = completedAt;
  state.run.durationMs = durationBetween(state.run.startedAt, completedAt);
  state.run.result = outcome.state;
  state.run.blockedBy = getOutcomeBlocker(outcome);
}

export interface CheckRunRecorder {
  block(task: ExecutionTaskIdentity, blockedBy: TaskReference): void;
  fail(
    task: ExecutionTaskIdentity,
    result: {
      completedAt: string;
      durationMs: number;
      reason?: string;
      stats?: LiminaCheckRunTaskStats;
    },
  ): void;
  finish(outcome: CompletedRunOutcome, completedAt?: string): void;
  getRunSummary(): LiminaCheckRunSummary;
  pass(
    task: ExecutionTaskIdentity,
    result: {
      completedAt: string;
      durationMs: number;
      stats?: LiminaCheckRunTaskStats;
    },
  ): void;
  project(task: ExecutionTaskIdentity, event: TaskLifecycleEvent): void;
  skip(task: ExecutionTaskIdentity, reason: string): void;
  start(task: ExecutionTaskIdentity, startedAt: string): void;
}

export interface CreateCheckRunRecorderOptions {
  command: string;
  configPath?: string;
  pipeline?: string;
  plannedTasks: readonly ExecutionTaskIdentity[];
  rootDir: string;
}

function createTaskSummary(
  task: ExecutionTaskIdentity,
): LiminaCheckRunTaskSummary {
  return {
    generation: task.generation,
    id: task.id,
    issueTask: task.issueTask,
    kind: task.kind,
    label: task.label,
    state: 'planned',
  };
}

function createTaskMap(
  tasks: readonly ExecutionTaskIdentity[],
): Map<ExecutionTaskIdentity['id'], LiminaCheckRunTaskSummary> {
  return new Map(tasks.map((task) => [task.id, createTaskSummary(task)]));
}

function assertUniqueTaskIds(
  tasks: readonly ExecutionTaskIdentity[],
  taskById: ReadonlyMap<ExecutionTaskIdentity['id'], LiminaCheckRunTaskSummary>,
): void {
  if (taskById.size !== tasks.length) {
    throw new Error('Recorder planned tasks contain duplicate task ids.');
  }
}

function createRunSummary(
  options: CreateCheckRunRecorderOptions,
  taskById: ReadonlyMap<ExecutionTaskIdentity['id'], LiminaCheckRunTaskSummary>,
): LiminaCheckRunSummary {
  return {
    command: options.command,
    configPath: options.configPath,
    createdAt: new Date().toISOString(),
    pipeline: options.pipeline,
    result: 'not-run',
    tasks: options.plannedTasks.map((task) => taskById.get(task.id)!),
  };
}

function createRecorder(state: RecorderState): CheckRunRecorder {
  return {
    block: (task, blockedBy) =>
      projectTask(state, task, { blockedBy, type: 'block' }),
    fail: (task, result) =>
      projectTask(state, task, { ...result, type: 'fail' }),
    finish: (outcome, completedAt = new Date().toISOString()) =>
      finishRun(state, outcome, completedAt),
    getRunSummary: () => cloneRun(state.run),
    pass: (task, result) =>
      projectTask(state, task, { ...result, type: 'pass' }),
    project: (task, event) => projectTask(state, task, event),
    skip: (task, reason) => projectTask(state, task, { reason, type: 'skip' }),
    start: (task, startedAt) =>
      projectTask(state, task, { startedAt, type: 'start' }),
  };
}

export function createCheckRunRecorder(
  options: CreateCheckRunRecorderOptions,
): CheckRunRecorder {
  const taskById = createTaskMap(options.plannedTasks);
  assertUniqueTaskIds(options.plannedTasks, taskById);

  return createRecorder({
    run: createRunSummary(options, taskById),
    taskById,
  });
}
