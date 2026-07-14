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

export type LiminaCheckRunTaskPlan = ExecutionTaskIdentity;

export interface LiminaCheckRunTaskStats {
  items?: readonly LiminaCheckRunCheckItemSummary[];
  passed: number;
  total: number;
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

function cloneRun(run: LiminaCheckRunSummary): LiminaCheckRunSummary {
  return {
    ...run,
    blockedBy: run.blockedBy ? { ...run.blockedBy } : undefined,
    tasks: run.tasks.map((task) => ({
      ...task,
      blockedBy: task.blockedBy ? { ...task.blockedBy } : undefined,
      checkItems: task.checkItems?.map((item) =>
        item.itemKind === 'checker-target'
          ? {
              ...item,
              blockedBy: item.blockedBy?.map((reference) => ({
                ...reference,
              })),
            }
          : { ...item },
      ),
    })),
  };
}

function durationBetween(
  startedAt: string | undefined,
  completedAt: string,
): number | undefined {
  if (!startedAt) return undefined;
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

function applyTaskStats(
  task: LiminaCheckRunTaskSummary,
  stats: LiminaCheckRunTaskStats | undefined,
): void {
  if (!stats) return;

  task.checksPassed = Math.max(0, stats.passed);
  task.checksTotal = Math.max(0, stats.total);
  task.checkItems = stats.items?.map((item) => {
    const normalized = {
      ...item,
      checksPassed:
        item.checksPassed === undefined
          ? undefined
          : Math.max(0, item.checksPassed),
      checksTotal:
        item.checksTotal === undefined
          ? undefined
          : Math.max(0, item.checksTotal),
      durationMs:
        item.durationMs === undefined
          ? undefined
          : Math.max(0, item.durationMs),
      issues: item.issues === undefined ? undefined : Math.max(0, item.issues),
    };
    return item.itemKind === 'checker-target'
      ? {
          ...normalized,
          blockedBy: item.blockedBy?.map((reference) => ({ ...reference })),
        }
      : normalized;
  });
}

export function createCheckRunRecorder(
  options: CreateCheckRunRecorderOptions,
): CheckRunRecorder {
  const createdAt = new Date().toISOString();
  const taskById = new Map(
    options.plannedTasks.map((task) => [
      task.id,
      {
        generation: task.generation,
        id: task.id,
        issueTask: task.issueTask,
        kind: task.kind,
        label: task.label,
        state: 'planned' as const,
      } satisfies LiminaCheckRunTaskSummary,
    ]),
  );

  if (taskById.size !== options.plannedTasks.length) {
    throw new Error('Recorder planned tasks contain duplicate task ids.');
  }

  const run: LiminaCheckRunSummary = {
    command: options.command,
    configPath: options.configPath,
    createdAt,
    pipeline: options.pipeline,
    result: 'not-run',
    tasks: options.plannedTasks.map((task) => taskById.get(task.id)!),
  };

  function getTask(identity: ExecutionTaskIdentity): LiminaCheckRunTaskSummary {
    const task = taskById.get(identity.id);

    if (!task) {
      throw new Error(`Recorder received unknown task id: ${identity.id}.`);
    }

    if (
      task.label !== identity.label ||
      task.kind !== identity.kind ||
      task.issueTask !== identity.issueTask ||
      task.generation !== identity.generation
    ) {
      throw new Error(
        `Recorder task identity mismatch for id: ${identity.id}.`,
      );
    }

    return task;
  }

  function project(
    identity: ExecutionTaskIdentity,
    event: TaskLifecycleEvent,
  ): void {
    const task = getTask(identity);
    const nextState = transitionTask(task.state, event);

    switch (event.type) {
      case 'start': {
        run.startedAt ??= event.startedAt;
        run.result = 'running';
        task.startedAt = event.startedAt;
        task.state = nextState;
        return;
      }
      case 'pass': {
        task.completedAt = event.completedAt;
        task.durationMs = event.durationMs;
        task.state = nextState;
        applyTaskStats(task, event.stats);
        return;
      }
      case 'fail': {
        task.completedAt = event.completedAt;
        task.durationMs = event.durationMs;
        task.reason = event.reason;
        task.state = nextState;
        applyTaskStats(task, event.stats);
        return;
      }
      case 'block': {
        task.blockedBy = { ...event.blockedBy };
        task.state = nextState;
        return;
      }
      case 'skip': {
        task.reason = event.reason;
        task.state = nextState;
      }
    }
  }

  return {
    block(task, blockedBy) {
      project(task, { blockedBy, type: 'block' });
    },
    fail(task, result) {
      project(task, { ...result, type: 'fail' });
    },
    finish(outcome, completedAt = new Date().toISOString()) {
      run.completedAt = completedAt;
      run.durationMs = durationBetween(run.startedAt, completedAt);
      run.result = outcome.state;
      run.blockedBy =
        outcome.state === 'blocked' && outcome.blocker
          ? { ...outcome.blocker }
          : undefined;
    },
    getRunSummary() {
      return cloneRun(run);
    },
    pass(task, result) {
      project(task, { ...result, type: 'pass' });
    },
    project,
    skip(task, reason) {
      project(task, { reason, type: 'skip' });
    },
    start(task, startedAt) {
      project(task, { startedAt, type: 'start' });
    },
  };
}
