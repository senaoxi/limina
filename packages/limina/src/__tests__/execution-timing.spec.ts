import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createCheckRunRecorder } from '../check-reporting/run-recorder';
import { ResourceLockSet } from '../execution/resources';
import { runScheduler } from '../execution/scheduler-loop';
import type { SchedulerContext } from '../execution/scheduler-types';
import { ExecutionStateStore } from '../execution/state-store';
import {
  type ExecutionTask,
  taskId,
  type TaskLifecycleEvent,
} from '../execution/tasks';
import { ExecutionTrace } from '../execution/trace';
import type { LiminaPreflightManager } from '../preflight';

function task(
  name: string,
  order: number,
  overrides: Partial<ExecutionTask> = {},
): ExecutionTask {
  return {
    id: taskId(name),
    label: name,
    issueTask: 'graph:check',
    kind: 'task',
    generation: 0,
    failPolicy: 'continue',
    order,
    resources: {},
    run: async () => ({ status: 'passed', issues: [] }),
    ...overrides,
  };
}

function scheduler(
  tasks: ExecutionTask[],
  options: {
    concurrency?: number;
    project?: (task: ExecutionTask, event: TaskLifecycleEvent) => Promise<void>;
  } = {},
) {
  const trace = new ExecutionTrace();
  const recorder = createCheckRunRecorder({
    command: 'timing test',
    rootDir: '/fixture',
    plannedTasks: tasks,
    trace,
  });
  let generation = 0;
  const context: SchedulerContext = {
    concurrency: options.concurrency ?? 2,
    controller: {
      get generation() {
        return generation;
      },
      startNextGeneration() {
        generation++;
      },
    },
    flowNodes: new Map(),
    infrastructureError: undefined,
    locks: new ResourceLockSet(),
    options: {
      checkRunRecorder: {
        ...recorder,
        async project(identity, event) {
          recorder.project(identity, event);
          await options.project?.(
            tasks.find((candidate) => candidate.id === identity.id)!,
            event,
          );
        },
      },
      command: 'timing test',
      rootDir: '/fixture',
      preflight: {} as LiminaPreflightManager,
    },
    orderedTasks: tasks,
    outcomes: new Map(),
    pending: new Map(tasks.map((entry) => [entry.id, entry])),
    pendingGenerationAdvance: false,
    running: new Map(),
    state: new ExecutionStateStore(tasks),
  };
  return { context, recorder, trace };
}

function assertIntervals(trace: ExecutionTrace) {
  const snapshot = trace.snapshot();
  const chain = snapshot.criticalChain!;
  expect(chain.segments[0]?.startMs).toBe(snapshot.scheduler.startMs);
  expect(chain.segments.at(-1)?.endMs).toBe(snapshot.scheduler.endMs);
  let duration = 0;
  for (const [index, segment] of chain.segments.entries()) {
    expect(segment.endMs).toBeGreaterThanOrEqual(segment.startMs);
    if (index > 0)
      expect(segment.startMs).toBe(chain.segments[index - 1]!.endMs);
    duration += segment.endMs - segment.startMs;
  }
  expect(duration).toBeCloseTo(chain.schedulerDurationMs, 8);
  const occupied = chain.segments
    .filter((segment) => segment.type === 'task-occupancy')
    .reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0);
  expect(occupied).toBeCloseTo(chain.occupiedDurationMs, 8);
  expect(chain.occupiedDurationMs + chain.unattributedGapMs).toBeCloseTo(
    chain.schedulerDurationMs,
    8,
  );
  for (const entry of snapshot.tasks) {
    for (const [index, pending] of entry.pending.entries()) {
      expect(pending.endMs).toBeGreaterThanOrEqual(pending.startMs);
      if (index > 0)
        expect(pending.startMs).toBe(entry.pending[index - 1]!.endMs);
    }
  }
}

describe('execution timing', () => {
  it.each(['start', 'pass'] as const)(
    'excludes delayed %s observers from runner timestamps',
    async (eventType) => {
      const secondStarted = Promise.withResolvers<void>();
      const tasks = [
        task('a', 0, {
          run: async () => {
            await secondStarted.promise;
            return { status: 'passed', issues: [] };
          },
        }),
        task('b', 1, {
          run: async () => {
            secondStarted.resolve();
            await delay(10);
            return { status: 'passed', issues: [] };
          },
        }),
      ];
      const { context, recorder, trace } = scheduler(tasks, {
        project: async (entry, event) => {
          if (entry.id === tasks[0]!.id && event.type === eventType)
            await delay(45);
        },
      });
      await runScheduler(context);
      recorder.finish({ state: 'passed' });
      const summary = recorder.getRunSummary();
      for (const entry of summary.tasks) {
        expect(
          Math.abs(
            Date.parse(entry.completedAt!) -
              Date.parse(entry.startedAt!) -
              entry.durationMs!,
          ),
        ).toBeLessThan(2);
      }
      const snapshots = trace.snapshot().tasks;
      if (eventType === 'start') {
        expect(
          snapshots[0]!.runnerStartedMs! - snapshots[0]!.dispatchedMs!,
        ).toBeGreaterThanOrEqual(35);
      } else {
        expect(
          snapshots[1]!.settlementStartedMs! - snapshots[1]!.runnerCompletedMs!,
        ).toBeGreaterThanOrEqual(25);
      }
      assertIntervals(trace);
    },
  );

  it.each([-3_600_000, 3_600_000])(
    'keeps run and runner intervals monotonic after a %i ms wall adjustment',
    async (offset) => {
      const { context, recorder } = scheduler([
        task('clock', 0, {
          run: async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(Date.now() + offset);
            await delay(10);
            return { status: 'passed', issues: [] };
          },
        }),
      ]);
      const start = performance.now();
      try {
        await runScheduler(context);
        recorder.finish({ state: 'passed' });
        const elapsed = performance.now() - start;
        const run = recorder.getRunSummary();
        expect(run.durationMs).toBeGreaterThan(0);
        expect(run.durationMs).toBeLessThanOrEqual(elapsed);
        expect(
          Math.abs(
            Date.parse(run.completedAt!) -
              Date.parse(run.startedAt!) -
              run.durationMs!,
          ),
        ).toBeLessThan(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('separates overlapping execution, dependency, capacity and resource waits', async () => {
    const allStarted = Promise.withResolvers<void>();
    const tasks = [
      task('writer', 0, {
        resources: { write: ['graph'] },
        run: async () => {
          await allStarted.promise;
          await delay(15);
          return { status: 'passed', issues: [] };
        },
      }),
      task('other', 1, {
        run: async () => {
          allStarted.resolve();
          await delay(35);
          return { status: 'passed', issues: [] };
        },
      }),
      task('reader', 2, { resources: { read: ['graph'] } }),
      task('dependent', 3, { after: [taskId('other')] }),
    ];
    const { context, trace } = scheduler(tasks);
    await runScheduler(context);
    const snapshot = trace.snapshot();
    expect(
      snapshot.tasks[2]!.pending.some((entry) => entry.reason === 'capacity'),
    ).toBe(true);
    expect(
      snapshot.tasks[3]!.pending.some((entry) => entry.reason === 'dependency'),
    ).toBe(true);
    expect(snapshot.tasks[0]!.runnerCompletedMs!).toBeGreaterThan(
      snapshot.tasks[1]!.runnerStartedMs!,
    );
    const occupiedSum = snapshot.tasks.reduce(
      (sum, entry) => sum + entry.releasedMs! - entry.dispatchedMs!,
      0,
    );
    expect(occupiedSum).toBeGreaterThan(
      snapshot.criticalChain!.schedulerDurationMs,
    );
    assertIntervals(trace);
    const resourceRun = scheduler([
      task('writer', 0, {
        resources: { write: ['graph'] },
        run: async () => {
          await delay(10);
          return { status: 'passed', issues: [] };
        },
      }),
      task('reader', 1, { resources: { read: ['graph'] } }),
    ]);
    await runScheduler(resourceRun.context);
    expect(
      resourceRun.trace
        .snapshot()
        .tasks[1]!.pending.some(
          (entry) =>
            entry.reason === 'resource' &&
            entry.blockers.includes(taskId('writer')),
        ),
    ).toBe(true);
    assertIntervals(resourceRun.trace);
  });

  it('keeps blocked and start-aborted tasks without invented runner intervals', async () => {
    const blocked = scheduler([
      task('failure', 0, {
        run: async () => {
          throw new Error('runner failed');
        },
      }),
      task('blocked', 1, { requiresSuccessOf: [taskId('failure')] }),
    ]);
    await runScheduler(blocked.context);
    expect(blocked.trace.snapshot().tasks[0]?.outcome).toBe('failed');
    expect(blocked.trace.snapshot().tasks[1]?.outcome).toBe('blocked');
    expect(blocked.trace.snapshot().tasks[1]?.runnerStartedMs).toBeUndefined();
    expect(
      blocked.recorder.getRunSummary().tasks[1]?.durationMs,
    ).toBeUndefined();
    const failure = new Error('start observer failed');
    const aborted = scheduler([task('aborted', 0)], {
      project: async (_, event) => {
        if (event.type === 'start') throw failure;
      },
    });
    await expect(runScheduler(aborted.context)).rejects.toBe(failure);
    expect(aborted.trace.snapshot().tasks[0]?.outcome).toBe(
      'infrastructure-start-failure',
    );
    expect(aborted.trace.snapshot().tasks[0]?.runnerStartedMs).toBeUndefined();
    expect(
      aborted.recorder.getRunSummary().tasks[0]?.durationMs,
    ).toBeUndefined();
    expect(aborted.context.running.size).toBe(0);
    assertIntervals(aborted.trace);
  });

  it('selects greatest accumulated occupancy instead of the latest predecessor release', async () => {
    const root = task('long', 0);
    const late = task('late', 1);
    const join = task('join', 2, { after: [root.id, late.id] });
    const trace = new ExecutionTrace();
    trace.beginScheduler([root, late, join]);
    await delay(10);
    trace.dispatched(root.id);
    await delay(30);
    trace.released(root.id, 'passed');
    await delay(10);
    trace.dispatched(late.id);
    trace.released(late.id, 'passed');
    trace.dispatched(join.id);
    await delay(5);
    trace.released(join.id, 'passed');
    trace.endScheduler();
    const chain = trace.snapshot().criticalChain!;
    expect(
      chain.segments
        .filter((segment) => segment.type === 'task-occupancy')
        .map((segment) => segment.taskId),
    ).toEqual([root.id, join.id]);
    expect(chain.unattributedGapMs).toBeGreaterThanOrEqual(15);
    expect(chain.occupiedDurationMs).toBeLessThan(chain.schedulerDurationMs);
    assertIntervals(trace);
  });

  it('records generation waits until the command and its joined peers settle', async () => {
    const tasks = [
      task('command', 0, { invalidatesPreflight: true }),
      task('peer', 1, {
        run: async () => {
          await delay(15);
          return { status: 'passed', issues: [] };
        },
      }),
      task('next', 2, { generation: 1 }),
    ];
    const { context, trace } = scheduler(tasks);
    await runScheduler(context);
    const snapshots = trace.snapshot().tasks;
    expect(snapshots[2]!.dispatchedMs!).toBeGreaterThanOrEqual(
      snapshots[1]!.releasedMs!,
    );
    expect(
      snapshots[2]!.pending.some((entry) => entry.reason === 'generation'),
    ).toBe(true);
    assertIntervals(trace);
  });
});
