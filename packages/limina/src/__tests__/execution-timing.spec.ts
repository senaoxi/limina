import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  AnalysisObserver,
  runWithProfile,
} from '../application/analysis/observability';
import { measureTaskProgress } from '../execution/progress';
import { ResourceLockSet } from '../execution/resources';
import { createCheckRunRecorder } from '../execution/run-recorder';
import { runScheduler } from '../execution/scheduler-loop';
import type { SchedulerContext } from '../execution/scheduler-types';
import { ExecutionStateStore } from '../execution/state-store';
import {
  type ExecutionTask,
  taskId,
  type TaskLifecycleEvent,
} from '../execution/tasks';
import { ExecutionTrace } from '../execution/trace';
import { createLiminaCheckFlowReporter } from '../flow';
import type { LiminaPreflightManager } from '../preflight';
import { encodeAnalysisProfile } from '../profiling/report-schema';

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

function reportedTasks(trace: ExecutionTrace, tasks: ExecutionTask[]) {
  const observer = new AnalysisObserver('limina check', performance.now());
  trace.reportProfileTasks(observer, tasks);
  return observer.snapshot().tasks;
}

describe('execution timing', () => {
  it('reports wall time outside the union of overlapping Flow phases', async () => {
    const output: string[] = [];
    const flow = createLiminaCheckFlowReporter({
      env: { CI: 'true' },
      output: {
        write: (line) => {
          output.push(line);
        },
      },
    });
    const entry = task('timed phases', 0, {
      run: async ({ progress }) => {
        if (progress === undefined) throw new Error('Missing Flow progress.');
        vi.advanceTimersByTime(10);
        const first = progress.startItem('first');
        vi.advanceTimersByTime(25);
        const second = progress.startItem('second');
        vi.advanceTimersByTime(45);
        first.pass();
        vi.advanceTimersByTime(50);
        second.pass();
        vi.advanceTimersByTime(100);
        const last = measureTaskProgress(progress, 'synchronous phase', () => {
          vi.advanceTimersByTime(2);
        });
        vi.advanceTimersByTime(88);
        await last;
        return { status: 'passed', issues: [] };
      },
    });
    const { context, recorder } = scheduler([entry]);
    context.flowNodes.set(entry.id, flow.tree(entry.label));
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      await runScheduler(context);
      expect(output.join('')).toContain('[pass] synchronous phase (2ms)');
      expect(output.join('')).toContain(
        '[pass] outside reported phases (198ms)',
      );
      expect(recorder.getRunSummary().tasks[0]?.durationMs).toBe(320);
    } finally {
      vi.useRealTimers();
      await flow.close();
    }
  });

  it.each(['start', 'pass'] as const)(
    'excludes delayed %s observers from runner timestamps',
    async (eventType) => {
      const secondStarted = Promise.withResolvers<void>();
      const observerEntered = Promise.withResolvers<void>();
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
            await observerEntered.promise;
            return { status: 'passed', issues: [] };
          },
        }),
      ];
      let observerFinishedAt = 0;
      const { context, recorder, trace } = scheduler(tasks, {
        project: async (entry, event) => {
          if (entry.id !== tasks[0]!.id || event.type !== eventType) return;
          observerEntered.resolve();
          if (eventType === 'pass') {
            // Wait for the other runner to finish before delaying settlement.
            await context.running.get(tasks[1]!.id)!.settlement;
          }
          await delay(45);
          observerFinishedAt = performance.timeOrigin + performance.now();
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
      const profiled = reportedTasks(trace, tasks);
      for (const [index, entry] of summary.tasks.entries()) {
        expect(profiled[index]!.runnerUs).toBe(
          Math.round(entry.durationMs! * 1000),
        );
        expect(profiled[index]!.queueWaitUs).toBeGreaterThanOrEqual(0);
      }
      if (eventType === 'start') {
        expect(profiled[0]!.dispatchToRunnerUs).toBeGreaterThanOrEqual(35_000);
        expect(Date.parse(summary.tasks[0]!.startedAt!)).toBeGreaterThanOrEqual(
          Math.floor(observerFinishedAt),
        );
      } else {
        expect(
          observerFinishedAt - Date.parse(summary.tasks[1]!.completedAt!),
        ).toBeGreaterThanOrEqual(35);
      }
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

  it('measures ready queue time after predecessors and the active generation', async () => {
    const tasks = [
      task('predecessor', 0, {
        run: async () => {
          await delay(35);
          return { status: 'passed', issues: [] };
        },
      }),
      task('dependent', 1, { requiresSuccessOf: [taskId('predecessor')] }),
      task('queued', 2, { invalidatesPreflight: true }),
      task('next-generation', 3, { generation: 1 }),
    ];
    const { context, trace } = scheduler(tasks, { concurrency: 1 });
    await runScheduler(context);
    const [, dependent, queued, nextGeneration] = reportedTasks(trace, tasks);
    for (const entry of [dependent!, nextGeneration!]) {
      expect(entry.readyQueueUs).toBeGreaterThanOrEqual(0);
      expect(entry.queueWaitUs! - entry.readyQueueUs!).toBeGreaterThan(25_000);
    }
    expect(queued!.readyQueueUs).toBeGreaterThan(25_000);
    expect(queued!.readyQueueUs).toBe(queued!.queueWaitUs);
  });

  it('times the runner body before profiling closes its work record', async () => {
    const clock = new Int32Array(new SharedArrayBuffer(4));
    let bodyUs = 0;
    const tasks = [
      task('body', 0, {
        run: async () => {
          const start = performance.now();
          await delay(5);
          bodyUs = Math.round((performance.now() - start) * 1000);
          return { status: 'passed', issues: [] };
        },
      }),
    ];
    const { context, trace } = scheduler(tasks);
    const observer = new AnalysisObserver('limina check', performance.now());
    const finish = observer.finish.bind(observer);
    vi.spyOn(observer, 'finish').mockImplementation((...finishArguments) => {
      Atomics.wait(clock, 0, 0, 45);
      finish(...finishArguments);
    });
    await runWithProfile(observer, () => runScheduler(context));
    trace.reportProfileTasks(observer, tasks);
    const profile = observer.snapshot();
    const runner = profile.tasks[0]!.runnerUs!;
    const span = profile.work.find(({ op }) => op === 'execution.task-runner');
    expect(Math.abs(runner - bodyUs)).toBeLessThan(30_000);
    expect(span).toMatchObject({ end: 'performed' });
    if (span?.end !== 'performed') throw new Error('Missing runner span.');
    expect(span.time[1] - span.time[0] - runner).toBeGreaterThan(35_000);
  });

  it('keeps blocked and start-aborted tasks without invented runner intervals', async () => {
    const blockedTasks = [
      task('failure', 0, {
        run: async () => {
          throw new Error('runner failed');
        },
      }),
      task('blocked', 1, { requiresSuccessOf: [taskId('failure')] }),
    ];
    const blocked = scheduler(blockedTasks);
    await runScheduler(blocked.context);
    const profiles = reportedTasks(blocked.trace, blockedTasks);
    expect(profiles[0]?.state).toBe('failed');
    expect(profiles[1]?.state).toBe('blocked');
    expect(profiles[1]?.runnerUs).toBeUndefined();
    expect(profiles[1]?.readyQueueUs).toBeUndefined();
    expect(profiles[1]?.dispatchToRunnerUs).toBeUndefined();
    expect(
      blocked.recorder.getRunSummary().tasks[1]?.durationMs,
    ).toBeUndefined();
    const failure = new Error('start observer failed');
    const abortedTasks = [task('aborted', 0)];
    const aborted = scheduler(abortedTasks, {
      project: async (_, event) => {
        if (event.type === 'start') throw failure;
      },
    });
    await expect(runScheduler(aborted.context)).rejects.toBe(failure);
    const [profile] = reportedTasks(aborted.trace, abortedTasks);
    expect(profile?.state).toBe('infrastructure-start-failure');
    expect(profile?.runnerUs).toBeUndefined();
    expect(profile?.dispatchToRunnerUs).toBeUndefined();
    expect(
      aborted.recorder.getRunSummary().tasks[0]?.durationMs,
    ).toBeUndefined();
    expect(aborted.context.running.size).toBe(0);
  });

  it('keeps readyQueueUs nonnegative and profile-encodable when waitOnlyWhenMatched bypasses an unsettled dependency', async () => {
    const buildId = taskId('checker:build');
    const prepareId = taskId('graph:materialize');
    const tasks = [
      task('graph:materialize', 0, {
        id: prepareId,
        issueTask: 'graph:materialize',
        kind: 'preparation',
      }),
      task('checker:build', 1, {
        id: buildId,
        issueTask: 'checker:build',
        requiresSuccessOf: [prepareId],
        run: async () => {
          await delay(40);
          return { issues: [], status: 'passed' };
        },
      }),
      task('graph:check', 2, {
        issueTask: 'graph:check',
        requiresSuccessOf: [prepareId],
        requiresSuccessOfWhen: {
          tasks: [buildId],
          test: () => false,
          waitOnlyWhenMatched: true,
        },
      }),
    ];
    const observer = new AnalysisObserver('limina check', performance.now());
    const { context, trace } = scheduler(tasks, { concurrency: 3 });
    await runWithProfile(observer, () => runScheduler(context));
    trace.reportProfileTasks(observer, tasks);
    observer.stop(true);
    const snapshot = observer.snapshot();
    const graphCheck = snapshot.tasks.find(
      (entry) => entry.name === 'graph:check',
    );
    expect(graphCheck?.readyQueueUs).toBeGreaterThanOrEqual(0);
    expect(() => encodeAnalysisProfile(snapshot)).not.toThrow();
  });
});
