import type { ResolvedLiminaConfig } from '#config/runner';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCheckRunRecorder } from '../check-reporting/run-recorder';
import { readCheckIssueSnapshot } from '../check-reporting/snapshot';
import { createCheckItemStats } from '../check-reporting/stats';
import {
  resolveCheckerBuildConcurrency,
  resolveCheckerTypecheckConcurrency,
  resolvePackageEntryConcurrency,
  resolveReleaseEntryConcurrency,
  resolveTaskConcurrency,
} from '../execution/config';
import { runExecutionTasks } from '../execution/executor';
import { sortCollectedIssues } from '../execution/issues';
import { runPool } from '../execution/pool';
import { ResourceLockSet, type ResourceRequest } from '../execution/resources';
import type { ExecutionTask, ExecutionTaskResult } from '../execution/tasks';
import { LiminaFlowReporter } from '../flow';
import type { LiminaPreflightManager } from '../preflight';
import type { LiminaCheckIssue } from '../source-check/snapshot';

const green = (message: string): string => `\u001B[32m${message}\u001B[0m`;

function createIssue(overrides: Partial<LiminaCheckIssue>): LiminaCheckIssue {
  return {
    code: 'TEST',
    reason: 'reason',
    task: 'graph:check',
    title: 'Issue',
    ...overrides,
  };
}

function createConfig(
  execution: ResolvedLiminaConfig['execution'] = {},
): ResolvedLiminaConfig {
  return {
    configPath: '/workspace/limina.config.mjs',
    execution,
    rootDir: '/workspace',
  };
}

async function withTempRoot<T>(
  run: (rootDir: string) => Promise<T>,
): Promise<T> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-execution-'));

  try {
    return await run(rootDir);
  } finally {
    await rm(rootDir, {
      force: true,
      recursive: true,
    });
  }
}

function createPreflight(
  rootDir: string,
  invalidateAll = () => {},
): LiminaPreflightManager {
  return {
    config: createConfig({
      tasks: 4,
    }),
    invalidateAll,
  } as unknown as LiminaPreflightManager;
}

function createBufferedTtyFlow(): {
  chunks: string[];
  flow: LiminaFlowReporter;
} {
  const chunks: string[] = [];

  return {
    chunks,
    flow: new LiminaFlowReporter({
      env: {},
      forceTty: true,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        columns: 80,
        isTTY: true,
      },
    }),
  };
}

function createTask(options: {
  deps?: readonly string[];
  delayMs?: number;
  failPolicy?: ExecutionTask['failPolicy'];
  id: string;
  issues?: readonly LiminaCheckIssue[];
  onRun?: () => void;
  order: number;
  passed?: boolean;
  resources?: ResourceRequest;
  invalidatesPreflight?: boolean;
}): ExecutionTask {
  return {
    deps: options.deps,
    failPolicy: options.failPolicy ?? 'continue',
    id: options.id,
    kind: 'task',
    name: options.id,
    order: options.order,
    resources: options.resources ?? {},
    run: async (): Promise<ExecutionTaskResult> => {
      options.onRun?.();
      if (options.delayMs) {
        await new Promise((resolve) => {
          setTimeout(resolve, options.delayMs);
        });
      }

      return {
        durationMs: options.delayMs ?? 0,
        id: options.id,
        invalidatesPreflight: options.invalidatesPreflight,
        issues: options.issues ?? [],
        name: options.id,
        passed: options.passed ?? true,
        status: options.passed === false ? 'failed' : 'passed',
      };
    },
  };
}

describe('runPool', () => {
  it('returns an empty array for empty input', async () => {
    await expect(
      runPool({
        concurrency: 2,
        items: [],
        run: (item) => item,
      }),
    ).resolves.toEqual([]);
  });

  it('rejects invalid concurrency', async () => {
    await expect(
      runPool({
        concurrency: 0,
        items: [1],
        run: (item) => item,
      }),
    ).rejects.toThrow(/concurrency/u);
  });

  it('does not exceed max active workers', async () => {
    let activeCount = 0;
    let maxActiveCount = 0;

    await runPool({
      concurrency: 2,
      items: [1, 2, 3, 4],
      run: async (item) => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
        activeCount -= 1;
        return item;
      },
    });

    expect(maxActiveCount).toBe(2);
  });

  it('preserves result order', async () => {
    await expect(
      runPool({
        concurrency: 3,
        items: [30, 10, 20],
        run: async (item, index) => {
          await new Promise((resolve) => {
            setTimeout(resolve, item);
          });
          return index;
        },
      }),
    ).resolves.toEqual([0, 1, 2]);
  });

  it('propagates errors without onError', async () => {
    await expect(
      runPool({
        concurrency: 2,
        items: [1],
        run: () => {
          throw new Error('failed');
        },
      }),
    ).rejects.toThrow('failed');
  });

  it('converts errors with onError', async () => {
    await expect(
      runPool({
        concurrency: 2,
        items: [1, 2],
        onError: (item) => item * 10,
        run: (item) => {
          if (item === 2) {
            throw new Error('failed');
          }

          return item;
        },
      }),
    ).resolves.toEqual([1, 20]);
  });
});

describe('ResourceLockSet', () => {
  it('allows read/read sharing', () => {
    const locks = new ResourceLockSet();

    locks.acquire('a', { read: ['graph'] });

    expect(locks.canAcquire({ read: ['graph'] })).toBe(true);
  });

  it('conflicts read/write and write/write', () => {
    const locks = new ResourceLockSet();

    locks.acquire('a', { read: ['graph'] });

    expect(locks.canAcquire({ write: ['graph'] })).toBe(false);

    locks.release('a');
    locks.acquire('b', { write: ['graph'] });

    expect(locks.canAcquire({ write: ['graph'] })).toBe(false);
  });

  it('conflicts exclusive resources with all access kinds', () => {
    const locks = new ResourceLockSet();

    locks.acquire('a', { exclusive: ['workspace'] });

    expect(locks.canAcquire({ read: ['workspace'] })).toBe(false);
    expect(locks.canAcquire({ write: ['workspace'] })).toBe(false);
    expect(locks.canAcquire({ exclusive: ['workspace'] })).toBe(false);
  });

  it('release removes locks', () => {
    const locks = new ResourceLockSet();

    locks.acquire('a', { write: ['graph'] });
    locks.release('a');

    expect(locks.canAcquire({ read: ['graph'] })).toBe(true);
  });
});

describe('sortCollectedIssues', () => {
  it('sorts by task order and stable issue fields', () => {
    const sorted = sortCollectedIssues([
      {
        issues: [
          createIssue({
            code: 'B',
            reason: 'z',
            title: 'late',
          }),
          createIssue({
            code: 'A',
            filePath: 'b.ts',
            reason: 'z',
            title: 'late',
          }),
          createIssue({
            code: 'A',
            filePath: 'a.ts',
            reason: 'z',
            title: 'late',
          }),
        ],
        taskId: 'second',
        taskOrder: 1,
      },
      {
        issues: [
          createIssue({
            code: 'Z',
            reason: 'first task',
            title: 'early',
          }),
        ],
        taskId: 'first',
        taskOrder: 0,
      },
    ]);

    expect(
      sorted.map((issue) => `${issue.code}:${issue.filePath ?? ''}`),
    ).toEqual(['Z:', 'A:a.ts', 'A:b.ts', 'B:']);
  });
});

describe('execution concurrency resolution', () => {
  it('resolves conservative auto defaults', () => {
    const config = createConfig();
    const parallelism = () => 8;

    expect(
      resolveTaskConcurrency({
        availableParallelism: parallelism,
        config,
        itemCount: 10,
      }),
    ).toBe(4);
    expect(
      resolveCheckerBuildConcurrency({
        availableParallelism: parallelism,
        config,
        itemCount: 10,
      }),
    ).toBe(8);
    expect(
      resolvePackageEntryConcurrency({
        availableParallelism: parallelism,
        config,
        itemCount: 10,
      }),
    ).toBe(4);
  });

  it('clamps explicit concurrency to the item count', () => {
    const config = createConfig({
      checkerTypecheck: 7,
      releaseEntries: 5,
      tasks: 10,
    });

    expect(
      resolveTaskConcurrency({
        config,
        itemCount: 3,
      }),
    ).toBe(3);
    expect(
      resolveCheckerTypecheckConcurrency({
        config,
        itemCount: 2,
      }),
    ).toBe(2);
    expect(
      resolveReleaseEntryConcurrency({
        config,
        itemCount: 1,
      }),
    ).toBe(1);
  });
});

describe('runExecutionTasks', () => {
  it('renders task tree progress without replaying completed stats items', async () => {
    await withTempRoot(async (rootDir) => {
      const { chunks, flow } = createBufferedTtyFlow();

      await runExecutionTasks({
        command: 'limina check',
        flow,
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [
          {
            failPolicy: 'continue',
            id: 'graph',
            kind: 'task',
            name: 'graph check',
            order: 0,
            resources: {},
            run: async (context): Promise<ExecutionTaskResult> => {
              const item = context?.progress?.startItem('source graph routes');

              item?.pass(undefined, { elapsedTimeMs: 5 });

              return {
                durationMs: 10,
                id: 'graph',
                issues: [],
                name: 'graph check',
                passed: true,
                stats: {
                  items: [
                    createCheckItemStats({
                      name: 'stats replay should stay hidden',
                      total: 1,
                    }),
                  ],
                  passed: 1,
                  total: 1,
                },
                status: 'passed',
              };
            },
          },
          createTask({ id: 'source', order: 1 }),
        ],
      });

      const output = chunks.join('');

      expect(output).toContain('◇      graph check\n');
      expect(output).toContain('◇      source\n');
      expect(output).toContain(
        `${green('◆')}        source graph routes (5ms)\n`,
      );
      expect(output).toContain(`${green('◆')}      graph check (10ms)\n`);
      expect(output).not.toContain('stats replay should stay hidden');
    });
  });

  it('marks blocked tree tasks as skipped with blocked-by context', async () => {
    await withTempRoot(async (rootDir) => {
      const { chunks, flow } = createBufferedTtyFlow();

      await runExecutionTasks({
        command: 'limina check demo',
        flow,
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [
          createTask({
            failPolicy: 'block-remaining',
            id: 'a',
            order: 0,
            passed: false,
          }),
          createTask({ deps: ['a'], id: 'b', order: 1 }),
        ],
      });

      expect(chunks.join('')).toContain('◇      b (blocked by a)\n');
    });
  });

  it('runs independent tasks concurrently', async () => {
    await withTempRoot(async (rootDir) => {
      let activeCount = 0;
      let maxActiveCount = 0;
      const onRun = () => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        setTimeout(() => {
          activeCount -= 1;
        }, 15);
      };

      const result = await runExecutionTasks({
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [
          createTask({ delayMs: 20, id: 'a', onRun, order: 0 }),
          createTask({ delayMs: 20, id: 'b', onRun, order: 1 }),
        ],
      });

      expect(result.passed).toBe(true);
      expect(maxActiveCount).toBe(2);
    });
  });

  it('waits for dependencies', async () => {
    await withTempRoot(async (rootDir) => {
      const calls: string[] = [];

      await runExecutionTasks({
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [
          createTask({
            delayMs: 10,
            id: 'a',
            onRun: () => calls.push('a'),
            order: 0,
          }),
          createTask({
            deps: ['a'],
            id: 'b',
            onRun: () => calls.push('b'),
            order: 1,
          }),
        ],
      });

      expect(calls).toEqual(['a', 'b']);
    });
  });

  it('waits for conflicting resources', async () => {
    await withTempRoot(async (rootDir) => {
      let activeCount = 0;
      let maxActiveCount = 0;
      const onRun = () => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        setTimeout(() => {
          activeCount -= 1;
        }, 15);
      };

      await runExecutionTasks({
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [
          createTask({
            delayMs: 20,
            id: 'a',
            onRun,
            order: 0,
            resources: { write: ['graph'] },
          }),
          createTask({
            delayMs: 20,
            id: 'b',
            onRun,
            order: 1,
            resources: { read: ['graph'] },
          }),
        ],
      });

      expect(maxActiveCount).toBe(1);
    });
  });

  it('continues independent tasks after a continue-policy failure', async () => {
    await withTempRoot(async (rootDir) => {
      const result = await runExecutionTasks({
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [
          createTask({ id: 'a', order: 0, passed: false }),
          createTask({ id: 'b', order: 1 }),
        ],
      });

      expect(result.passed).toBe(false);
      expect(result.results.map((taskResult) => taskResult.status)).toEqual([
        'failed',
        'passed',
      ]);
    });
  });

  it('blocks remaining ordered work after a block-policy failure', async () => {
    await withTempRoot(async (rootDir) => {
      const recorder = createCheckRunRecorder({
        command: 'limina check demo',
        plannedTasks: [
          { kind: 'command', name: 'a' },
          { kind: 'command', name: 'b' },
        ],
        rootDir,
      });
      const result = await runExecutionTasks({
        checkRunRecorder: recorder,
        command: 'limina check demo',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [
          createTask({
            failPolicy: 'block-remaining',
            id: 'a',
            order: 0,
            passed: false,
          }),
          createTask({ deps: ['a'], id: 'b', order: 1 }),
        ],
      });
      const snapshot = await readCheckIssueSnapshot(rootDir);

      expect(result.results.map((taskResult) => taskResult.status)).toEqual([
        'failed',
        'blocked',
      ]);
      expect(snapshot?.run?.result).toBe('blocked');
      expect(snapshot?.run?.tasks.map((task) => task.status)).toEqual([
        'failed',
        'skipped',
      ]);
    });
  });

  it('invalidates preflight after invalidating tasks finish', async () => {
    await withTempRoot(async (rootDir) => {
      let invalidations = 0;

      await runExecutionTasks({
        command: 'limina check',
        preflight: createPreflight(rootDir, () => {
          invalidations += 1;
        }),
        rootDir,
        tasks: [
          createTask({
            id: 'a',
            invalidatesPreflight: true,
            order: 0,
          }),
        ],
      });

      expect(invalidations).toBe(1);
    });
  });

  it('writes deterministic issue order by task order', async () => {
    await withTempRoot(async (rootDir) => {
      await runExecutionTasks({
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [
          createTask({
            id: 'a',
            issues: [createIssue({ code: 'B' })],
            order: 0,
            passed: false,
          }),
          createTask({
            id: 'b',
            issues: [createIssue({ code: 'A' })],
            order: 1,
            passed: false,
          }),
        ],
      });
      const snapshot = await readCheckIssueSnapshot(rootDir);

      expect(snapshot?.issues.map((issue) => issue.code)).toEqual(['B', 'A']);
    });
  });
});
