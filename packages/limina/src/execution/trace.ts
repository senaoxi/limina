import type { AnalysisObserver } from '../application/analysis/observability';
import type { ExecutionTask, TaskId } from './tasks';

interface TaskTiming {
  dispatchedAt?: number;
  readyAt?: number;
  runnerStartedAt?: number;
  runnerCompletedAt?: number;
  settledAt?: number;
  outcome?: string;
}

function elapsedUs(start?: number, end?: number): number | undefined {
  return start === undefined || end === undefined
    ? undefined
    : Math.round((end - start) * 1000);
}

function getAwaitedDependencies(
  task: ExecutionTask,
  shouldIncludeConditional: boolean,
): TaskId[] {
  return [
    ...(task.after ?? []),
    ...(task.requiresSuccessOf ?? []),
    ...(shouldIncludeConditional
      ? (task.requiresSuccessOfWhen?.tasks ?? [])
      : []),
  ];
}

export class ExecutionTrace {
  readonly #tasks = new Map<TaskId, TaskTiming>();
  readonly #profileTaskIds = new Map<TaskId, string>();
  readonly #generations = new Map<number, number>();
  #schedulerStart?: number;
  #readyAt(
    task: ExecutionTask,
    shouldIncludeConditional = true,
  ): number | undefined {
    let readyAt = this.#generations.get(task.generation);
    if (readyAt === undefined) return undefined;
    for (const dependency of getAwaitedDependencies(
      task,
      shouldIncludeConditional,
    )) {
      const settledAt = this.#tasks.get(dependency)?.settledAt;
      if (settledAt === undefined) return undefined;
      readyAt = Math.max(readyAt, settledAt);
    }
    return readyAt;
  }

  profileTaskId(id: TaskId): string {
    const existing = this.#profileTaskIds.get(id);
    if (existing !== undefined) return existing;
    const profileId = `task-${this.#profileTaskIds.size + 1}`;
    this.#profileTaskIds.set(id, profileId);
    return profileId;
  }

  beginScheduler(tasks: readonly ExecutionTask[], generation: number): void {
    const start = performance.now();
    this.#schedulerStart = start;
    this.#generations.set(generation, start);
    for (const task of tasks) {
      this.profileTaskId(task.id);
      this.#tasks.set(task.id, {});
    }
  }

  generationStarted(generation: number): void {
    this.#generations.set(generation, performance.now());
  }

  dependenciesSettled(
    task: ExecutionTask,
    shouldIncludeConditional: boolean,
  ): void {
    const timing = this.#tasks.get(task.id);
    if (timing === undefined || timing.readyAt !== undefined) return;
    timing.readyAt = this.#readyAt(task, shouldIncludeConditional);
  }

  dispatched(id: TaskId): void {
    const task = this.#tasks.get(id);
    if (task !== undefined) task.dispatchedAt = performance.now();
  }

  runnerStarted(id: TaskId, time: number): void {
    const task = this.#tasks.get(id);
    if (task !== undefined) task.runnerStartedAt = time;
  }

  runnerCompleted(id: TaskId, time: number): void {
    const task = this.#tasks.get(id);
    if (task !== undefined) task.runnerCompletedAt = time;
  }

  settled(id: TaskId, outcome: string): void {
    const task = this.#tasks.get(id);
    if (task === undefined) return;
    task.outcome = outcome;
    task.settledAt = performance.now();
  }

  endScheduler(): void {
    for (const task of this.#tasks.values())
      task.outcome ??= 'not-started-infrastructure-failure';
  }

  reportProfileTasks(
    observer: AnalysisObserver,
    tasks: readonly ExecutionTask[],
  ): void {
    for (const task of tasks) {
      const observed = this.#tasks.get(task.id);
      const dispatchedAt = observed?.dispatchedAt;
      const readyAt =
        observed?.readyAt ??
        this.#readyAt(
          task,
          task.requiresSuccessOfWhen?.waitOnlyWhenMatched !== true,
        );
      observer.task(this.profileTaskId(task.id), {
        name: task.issueTask,
        queueWaitUs: elapsedUs(this.#schedulerStart, dispatchedAt),
        readyQueueUs:
          dispatchedAt === undefined
            ? undefined
            : elapsedUs(readyAt, dispatchedAt),
        dispatchToRunnerUs: elapsedUs(dispatchedAt, observed?.runnerStartedAt),
        runnerUs: elapsedUs(
          observed?.runnerStartedAt,
          observed?.runnerCompletedAt,
        ),
        state: observed?.outcome ?? 'planned',
      });
    }
  }
}
