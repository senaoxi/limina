import type { AnalysisObserver } from '../application/analysis/observability';
import type { ExecutionTask, TaskId } from './tasks';

export type PendingReason =
  | 'generation'
  | 'dependency'
  | 'capacity'
  | 'resource'
  | 'scheduling';

interface PendingObservation {
  blockers: readonly TaskId[];
  reason: PendingReason;
  resources?: readonly string[];
}

interface PendingInterval extends PendingObservation {
  endMs: number;
  startMs: number;
}

interface TaskTrace {
  after: readonly TaskId[];
  dispatchedMs?: number;
  generation: number;
  id: TaskId;
  label: string;
  outcome?: string;
  pending: PendingInterval[];
  releasedMs?: number;
  requiresSuccessOf: readonly TaskId[];
  runnerCompletedMs?: number;
  runnerStartedMs?: number;
  settlementStartedMs?: number;
}

interface PhaseInterval {
  endMs: number;
  name: string;
  startMs: number;
}

interface ChainSegment {
  endMs: number;
  startMs: number;
  taskId?: TaskId;
  type: 'unattributed-gap' | 'task-occupancy';
}

interface CriticalChainSnapshot {
  occupiedDurationMs: number;
  schedulerDurationMs: number;
  unattributedGapMs: number;
  segments: ChainSegment[];
  scope: string;
  gapScope: string;
  fullCriticalPath: string;
}

interface ExecutionTraceSnapshot {
  clock: string;
  criticalChain: CriticalChainSnapshot | null;
  origin: string;
  pendingPriority: PendingReason[];
  phases: PhaseInterval[];
  scheduler: { startMs: number | undefined; endMs: number | undefined };
  taskCpuTime: string;
  nestedResourceWait: string;
  tasks: TaskTrace[];
}

/**
Opt-in observations only; never controls scheduling or issue authority.
*/
export class ExecutionTrace {
  readonly #origin = performance.now();
  readonly #wallOrigin = performance.timeOrigin + this.#origin;
  readonly #tasks = new Map<TaskId, TaskTrace>();
  readonly #profileTaskIds?: Map<TaskId, string>;
  readonly #phases: PhaseInterval[] = [];
  #schedulerStart?: number;
  #schedulerEnd?: number;

  constructor(shouldProfileTasks = false) {
    if (shouldProfileTasks) this.#profileTaskIds = new Map();
  }

  #predecessors(task: TaskTrace): TaskTrace[] {
    const candidates = new Set([
      ...task.after,
      ...task.requiresSuccessOf,
      ...task.pending.flatMap((interval) => interval.blockers),
    ]);
    return [...candidates]
      .map((id) => this.#tasks.get(id))
      .filter(
        (candidate): candidate is TaskTrace =>
          candidate?.dispatchedMs !== undefined &&
          candidate.releasedMs !== undefined &&
          candidate.releasedMs <= task.dispatchedMs!,
      );
  }

  #criticalChain(): CriticalChainSnapshot | null {
    if (this.#schedulerStart === undefined || this.#schedulerEnd === undefined)
      return null;
    const executed = this.#tasks
      .values()
      .filter(
        (task) =>
          task.dispatchedMs !== undefined && task.releasedMs !== undefined,
      )
      .toArray()
      .sort((left, right) => left.dispatchedMs! - right.dispatchedMs!);
    const paths = new Map<TaskId, { durationMs: number; tasks: TaskTrace[] }>();
    let longest = { durationMs: 0, tasks: [] as TaskTrace[] };
    for (const task of executed) {
      let predecessor = { durationMs: 0, tasks: [] as TaskTrace[] };
      for (const candidate of this.#predecessors(task)) {
        const path = paths.get(candidate.id);
        if (path !== undefined && path.durationMs > predecessor.durationMs)
          predecessor = path;
      }
      const path = {
        durationMs:
          predecessor.durationMs + task.releasedMs! - task.dispatchedMs!,
        tasks: [...predecessor.tasks, task],
      };
      paths.set(task.id, path);
      if (path.durationMs > longest.durationMs) longest = path;
    }
    let end = this.#schedulerStart;
    const segments: ChainSegment[] = [];
    for (const task of longest.tasks) {
      segments.push(
        { startMs: end, endMs: task.dispatchedMs!, type: 'unattributed-gap' },
        {
          startMs: task.dispatchedMs!,
          endMs: task.releasedMs!,
          taskId: task.id,
          type: 'task-occupancy',
        },
      );
      end = task.releasedMs!;
    }
    segments.push({
      startMs: end,
      endMs: this.#schedulerEnd,
      type: 'unattributed-gap',
    });
    const schedulerDurationMs = this.#schedulerEnd - this.#schedulerStart;
    return {
      occupiedDurationMs: longest.durationMs,
      schedulerDurationMs,
      unattributedGapMs: schedulerDurationMs - longest.durationMs,
      segments,
      scope:
        'longest non-overlapping occupancy path through declared dependencies and observed outer scheduler blockers; elapsed lower bound, not full critical path',
      gapScope:
        'unattributed elapsed time; can include independent work, dispatch latency and unobserved constraints',
      fullCriticalPath:
        'unavailable: nested waits and unobserved causal intervals are not instrumented',
    };
  }

  profileTaskId(id: TaskId): string | undefined {
    const ids = this.#profileTaskIds;
    if (ids === undefined) return undefined;
    const taskId = ids.get(id);
    if (taskId !== undefined) return taskId;
    const allocated = `task-${ids.size + 1}`;
    ids.set(id, allocated);
    return allocated;
  }

  now(): number {
    return performance.now() - this.#origin;
  }

  phase(name: string, startMs: number): void {
    this.#phases.push({ endMs: this.now(), name, startMs });
  }

  beginScheduler(tasks: readonly ExecutionTask[]): void {
    this.#schedulerStart = this.now();
    for (const task of tasks) {
      if (this.#profileTaskIds !== undefined) this.profileTaskId(task.id);
      this.#tasks.set(task.id, {
        after: [
          ...new Set([
            ...(task.after ?? []),
            ...(task.requiresSuccessOfWhen?.tasks ?? []),
          ]),
        ],
        generation: task.generation,
        id: task.id,
        label: task.label,
        pending: [],
        requiresSuccessOf: [...(task.requiresSuccessOf ?? [])],
      });
    }
  }

  observe(id: TaskId, observation: PendingObservation): void {
    const task = this.#tasks.get(id);
    if (
      task === undefined ||
      task.dispatchedMs !== undefined ||
      task.outcome !== undefined
    )
      return;
    const now = this.now();
    const previous = task.pending.at(-1);
    if (previous !== undefined) previous.endMs = now;
    if (
      previous !== undefined &&
      previous.reason === observation.reason &&
      previous.blockers.join('\0') === observation.blockers.join('\0') &&
      previous.resources?.join('\0') === observation.resources?.join('\0')
    )
      return;
    task.pending.push({ ...observation, endMs: now, startMs: now });
  }

  dispatched(id: TaskId): void {
    const task = this.#tasks.get(id);
    if (task === undefined) return;
    task.dispatchedMs = this.now();
    const pending = task.pending.at(-1);
    if (pending !== undefined) pending.endMs = task.dispatchedMs;
  }

  runnerStarted(id: TaskId, time: number): void {
    const task = this.#tasks.get(id);
    if (task !== undefined) task.runnerStartedMs = time - this.#origin;
  }

  runnerCompleted(id: TaskId, time: number): void {
    const task = this.#tasks.get(id);
    if (task !== undefined) task.runnerCompletedMs = time - this.#origin;
  }

  settlementStarted(id: TaskId): void {
    const task = this.#tasks.get(id);
    if (task !== undefined) task.settlementStartedMs = this.now();
  }

  released(id: TaskId, outcome: string): void {
    const task = this.#tasks.get(id);
    if (task === undefined) return;
    task.releasedMs = this.now();
    task.outcome = outcome;
    if (task.dispatchedMs !== undefined) return;
    const pending = task.pending.at(-1);
    if (pending !== undefined) pending.endMs = task.releasedMs;
  }

  endScheduler(): void {
    this.#schedulerEnd = this.now();
    for (const task of this.#tasks.values()) {
      if (task.outcome !== undefined) continue;
      const pending = task.pending.at(-1);
      if (pending !== undefined) pending.endMs = this.#schedulerEnd;
      task.outcome = 'not-started-infrastructure-failure';
    }
  }

  reportProfileTasks(
    observer: AnalysisObserver,
    tasks: readonly ExecutionTask[],
  ): void {
    for (const task of tasks) {
      const profileId = this.profileTaskId(task.id);
      if (profileId === undefined) continue;
      const observed = this.#tasks.get(task.id);
      const queueWaitMs =
        observed?.dispatchedMs === undefined ||
        this.#schedulerStart === undefined
          ? undefined
          : observed.dispatchedMs - this.#schedulerStart;
      const runnerMs =
        observed?.runnerStartedMs === undefined ||
        observed.runnerCompletedMs === undefined
          ? undefined
          : observed.runnerCompletedMs - observed.runnerStartedMs;
      observer.task(profileId, {
        name: task.issueTask,
        queueWaitUs:
          queueWaitMs === undefined
            ? undefined
            : Math.round(queueWaitMs * 1000),
        runnerUs:
          runnerMs === undefined ? undefined : Math.round(runnerMs * 1000),
        state: observed?.outcome ?? 'planned',
      });
    }
  }

  snapshot(): ExecutionTraceSnapshot {
    return {
      clock:
        'monotonic milliseconds relative to trace creation (CLI check entry for CLI profiles)',
      criticalChain: this.#criticalChain(),
      origin: new Date(this.#wallOrigin).toISOString(),
      pendingPriority: [
        'generation',
        'dependency',
        'capacity',
        'resource',
        'scheduling',
      ],
      phases: this.#phases.map((phase) => ({ ...phase })),
      scheduler: { startMs: this.#schedulerStart, endMs: this.#schedulerEnd },
      taskCpuTime: 'unavailable',
      nestedResourceWait: 'unavailable; runner intervals are inclusive',
      tasks: this.#tasks
        .values()
        .map((task) => ({
          ...task,
          pending: task.pending.map((interval) => ({ ...interval })),
        }))
        .toArray(),
    };
  }
}
