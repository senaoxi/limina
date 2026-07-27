import type {
  CompletedRunOutcome,
  ExecutionTaskIdentity,
  TaskLifecycleEvent,
  TaskReference,
} from '../execution/tasks';
import {
  cloneRun,
  finishRun,
  projectTask,
  type RecorderState,
} from './run-recorder-projection';
import type { LiminaCheckRunTaskStats } from './run-recorder-types';
import type {
  LiminaCheckRunSummary,
  LiminaCheckRunTaskSummary,
} from './snapshot';

export type { LiminaCheckRunTaskStats } from './run-recorder-types';

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
