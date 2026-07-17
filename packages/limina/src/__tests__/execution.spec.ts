import type { ResolvedLiminaConfig } from '#config/runner';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createCheckRunRecorder } from '../check-reporting/run-recorder';
import {
  getSourceIssueSnapshotPath,
  readCheckIssueSnapshot,
  readSourceIssueSnapshot,
  writeCheckIssueSnapshotOnly,
  writeNotRunCheckIssueSnapshot,
  writeSourceIssueSnapshotOnly,
} from '../check-reporting/snapshot';
import { createCheckItemStats } from '../check-reporting/stats';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import {
  resolveCheckerBuildConcurrency,
  resolveCheckerTypecheckConcurrency,
  resolvePackageEntryConcurrency,
  resolveReleaseEntryConcurrency,
  resolveTaskConcurrency,
} from '../execution/config';
import {
  createCompletedRunOutcome,
  resolveRootBlocker,
  runExecutionTasks,
  validateExecutionPlan,
} from '../execution/executor';
import { sortCollectedIssues } from '../execution/issues';
import { runPool } from '../execution/pool';
import { ResourceLockSet, type ResourceRequest } from '../execution/resources';
import { transitionTask } from '../execution/state-store';
import type { ExecutionTask, ExecutionTaskOutcome } from '../execution/tasks';
import { taskId } from '../execution/tasks';
import { LiminaFlowReporter } from '../flow';
import { LiminaPreflightManager } from '../preflight';
import {
  SOURCE_ISSUE_CODES,
  type SourceCheckIssue,
} from '../source-check/report';
import type { LiminaCheckIssue } from '../source-check/snapshot';
import { createCheckerTargetId } from '../typecheck/targets';
import { createPreflightGenerationController } from './helpers/preflight-generation';

const execFileAsync = promisify(execFile);
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

function createPreflight(rootDir: string): LiminaPreflightManager {
  return new LiminaPreflightManager({
    config: {
      ...createConfig({
        tasks: 4,
      }),
      rootDir,
    },
    generatedGraphProvider: async () =>
      ({ artifactPlan: { changes: [] } }) as never,
    providers: {} as never,
  });
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
  after?: readonly string[];
  delayMs?: number;
  failPolicy?: ExecutionTask['failPolicy'];
  generation?: number;
  id: string;
  issues?: readonly LiminaCheckIssue[];
  onRun?: () => void;
  order: number;
  passed?: boolean;
  resources?: ResourceRequest;
  invalidatesPreflight?: boolean;
}): ExecutionTask {
  return {
    after: options.after?.map(taskId),
    failPolicy: options.failPolicy ?? 'continue',
    generation: options.generation ?? 0,
    id: taskId(options.id),
    invalidatesPreflight: options.invalidatesPreflight,
    issueTask: 'graph:check',
    kind: 'task',
    label: options.id,
    order: options.order,
    resources: options.resources ?? {},
    run: async () => {
      options.onRun?.();
      if (options.delayMs) {
        await new Promise((resolve) => {
          setTimeout(resolve, options.delayMs);
        });
      }

      return {
        issues: options.issues ?? [],
        status: options.passed === false ? 'failed' : 'passed',
      };
    },
  };
}

function asAdvancementCommand(task: ExecutionTask): ExecutionTask {
  task.failPolicy = 'stop-pipeline';
  task.invalidatesPreflight = true;
  task.issueTask = 'command';
  task.kind = 'command';
  return task;
}

describe('validateExecutionPlan', () => {
  function validate(tasks: ExecutionTask[]): void {
    validateExecutionPlan({ tasks, userTaskCount: tasks.length });
  }

  it('accepts generation zero and a valid continuous multi-generation plan', () => {
    expect(() =>
      validate([createTask({ id: 'only', order: 0 })]),
    ).not.toThrow();

    const first = createTask({ id: 'first', order: 0 });
    const command = asAdvancementCommand(
      createTask({ after: ['first'], id: 'command', order: 1 }),
    );
    const next = createTask({
      after: ['command'],
      generation: 1,
      id: 'next',
      order: 2,
    });
    expect(() => validate([first, command, next])).not.toThrow();
  });

  it.each([
    [
      'does not start at zero',
      [createTask({ generation: 1, id: 'a', order: 0 })],
      /start at 0/u,
    ],
    [
      'contains a generation gap',
      [
        asAdvancementCommand(createTask({ id: 'command', order: 0 })),
        createTask({ generation: 2, id: 'later', order: 1 }),
      ],
      /continuous/u,
    ],
    [
      'rolls generation backward by order',
      [
        createTask({ id: 'zero', order: 0 }),
        createTask({ generation: 1, id: 'one', order: 1 }),
        createTask({ generation: 0, id: 'back', order: 2 }),
      ],
      /must not decrease/u,
    ],
  ] as const)('rejects a plan that %s', (_name, tasks, problem) => {
    expect(() => validate([...tasks])).toThrow(problem);
  });

  it('rejects dependencies on a future generation', () => {
    const current = createTask({ id: 'current', order: 0 });
    const future = createTask({ generation: 1, id: 'future', order: 1 });
    current.requiresSuccessOf = [future.id];
    expect(() => validate([current, future])).toThrow('future generation');
  });

  it('rejects missing, duplicate, and malformed advancement boundaries', () => {
    const missing = [
      createTask({ id: 'zero', order: 0 }),
      createTask({ generation: 1, id: 'one', order: 1 }),
    ];
    expect(() => validate(missing)).toThrow('exactly one advancement');

    const firstCommand = asAdvancementCommand(
      createTask({ id: 'c1', order: 0 }),
    );
    const secondCommand = asAdvancementCommand(
      createTask({ id: 'c2', order: 1 }),
    );
    expect(() => validate([firstCommand, secondCommand])).toThrow(
      'multiple advancement commands',
    );

    const notCommand = createTask({
      id: 'not-command',
      invalidatesPreflight: true,
      order: 0,
    });
    expect(() => validate([notCommand])).toThrow('stop-pipeline command');

    const notStopping = createTask({
      id: 'not-stopping',
      invalidatesPreflight: true,
      order: 0,
    });
    notStopping.kind = 'command';
    notStopping.issueTask = 'command';
    expect(() => validate([notStopping])).toThrow('stop-pipeline command');

    const earlyCommand = asAdvancementCommand(
      createTask({ id: 'early', order: 0 }),
    );
    const sameGenerationTail = createTask({ id: 'tail', order: 1 });
    expect(() => validate([earlyCommand, sameGenerationTail])).toThrow(
      'final task in its generation',
    );
  });
});

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
            generation: 0,
            id: taskId('graph'),
            issueTask: 'graph:check',
            kind: 'task',
            label: 'graph check',
            order: 0,
            resources: {},
            run: async (context) => {
              const item = context.progress?.startItem('source graph routes');

              item?.pass(undefined, { elapsedTimeMs: 5 });

              return {
                issues: [],
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
      expect(output).toMatch(/graph check \(\d+ms\)/u);
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
            failPolicy: 'stop-pipeline',
            id: 'a',
            order: 0,
            passed: false,
          }),
          createTask({ after: ['a'], id: 'b', order: 1 }),
        ],
      });

      expect(chunks.join('')).toContain(
        '◇      b (skipped after "a" failed)\n',
      );
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
            after: ['a'],
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

  it('blocks only requiresSuccessOf consumers after dependency failure', async () => {
    await withTempRoot(async (rootDir) => {
      let afterRan = false;
      let requiredRan = false;
      const failed = createTask({ id: 'failed', order: 0, passed: false });
      const after = createTask({
        after: ['failed'],
        id: 'after',
        onRun: () => {
          afterRan = true;
        },
        order: 1,
      });
      const required = createTask({
        id: 'required',
        onRun: () => {
          requiredRan = true;
        },
        order: 2,
      });
      required.requiresSuccessOf = [failed.id];

      const result = await runExecutionTasks({
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [failed, after, required],
      });

      expect(afterRan).toBe(true);
      expect(requiredRan).toBe(false);
      expect(result.results.map((entry) => entry.status)).toEqual([
        'failed',
        'passed',
        'blocked',
      ]);
    });
  });

  it('preserves the original failed root through transitive dependency blocks', async () => {
    await withTempRoot(async (rootDir) => {
      const failed = createTask({ id: 'a', order: 0, passed: false });
      const blocked = createTask({ id: 'b', order: 1 });
      blocked.requiresSuccessOf = [failed.id];
      const transitive = createTask({ id: 'c', order: 2 });
      transitive.requiresSuccessOf = [blocked.id];
      const tasks = [failed, blocked, transitive];
      const recorder = createCheckRunRecorder({
        command: 'limina check',
        plannedTasks: tasks,
        rootDir,
      });

      await runExecutionTasks({
        checkRunRecorder: recorder,
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks,
      });
      const snapshot = await readCheckIssueSnapshot(rootDir);
      expect(
        snapshot?.run?.tasks.slice(1).map((task) => task.blockedBy),
      ).toEqual([
        { id: failed.id, label: failed.label },
        { id: failed.id, label: failed.label },
      ]);
      expect(snapshot?.run?.blockedBy).toEqual({
        id: failed.id,
        label: failed.label,
      });
    });
  });

  it('selects the first failed dependency in plan order regardless of timing', async () => {
    await withTempRoot(async (rootDir) => {
      const first = createTask({
        delayMs: 20,
        id: 'first',
        order: 0,
        passed: false,
      });
      const second = createTask({ id: 'second', order: 1, passed: false });
      const consumer = createTask({ id: 'consumer', order: 2 });
      consumer.requiresSuccessOf = [second.id, first.id];
      const tasks = [first, second, consumer];
      const recorder = createCheckRunRecorder({
        command: 'limina check',
        plannedTasks: tasks,
        rootDir,
      });

      await runExecutionTasks({
        checkRunRecorder: recorder,
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks,
      });
      expect(
        (await readCheckIssueSnapshot(rootDir))?.run?.tasks[2],
      ).toMatchObject({
        blockedBy: { id: first.id, label: first.label },
        state: 'blocked',
      });
    });
  });

  it('uses a skipped dependency root cause without parsing its reason', () => {
    const failedCommand = asAdvancementCommand(
      createTask({ id: 'command', order: 0 }),
    );
    const skipped = createTask({ id: 'skipped', order: 1 });
    const outcome: ExecutionTaskOutcome = {
      causedBy: { id: failedCommand.id, label: failedCommand.label },
      reason: 'arbitrary localized text',
      status: 'skipped',
    };

    expect(resolveRootBlocker(skipped, outcome)).toEqual(outcome.causedBy);
    expect(() =>
      createCompletedRunOutcome(
        [skipped],
        new Map([
          [
            skipped.id,
            {
              reason: 'missing root',
              status: 'skipped',
            } as ExecutionTaskOutcome,
          ],
        ]),
      ),
    ).toThrow('missing its root cause');
  });

  it('classifies materializer rejection and blocks its checker consumer', async () => {
    await withTempRoot(async (rootDir) => {
      const materializer = createTask({ id: 'materializer', order: 0 });
      materializer.issueTask = 'graph:materialize';
      materializer.kind = 'preparation';
      materializer.label = 'graph:materialize';
      materializer.run = async () => {
        throw new Error('disk rejected generated artifacts');
      };
      const checker = createTask({ id: 'checker', order: 1 });
      checker.issueTask = 'checker:build';
      checker.requiresSuccessOf = [materializer.id];
      const recorder = createCheckRunRecorder({
        command: 'limina check',
        plannedTasks: [materializer, checker],
        rootDir,
      });

      const result = await runExecutionTasks({
        checkRunRecorder: recorder,
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [materializer, checker],
      });
      const snapshot = await readCheckIssueSnapshot(rootDir);

      expect(result.results.map((entry) => entry.status)).toEqual([
        'failed',
        'blocked',
      ]);
      expect(snapshot?.issues[0]).toMatchObject({
        code: 'LIMINA_GRAPH_MATERIALIZE_FAILED',
        domain: 'graph',
        id: expect.any(String),
        severity: 'error',
        task: 'graph:materialize',
      });
      expect(snapshot?.run?.tasks[1]).toMatchObject({
        blockedBy: {
          id: materializer.id,
          label: materializer.label,
        },
        state: 'blocked',
      });
    });
  });

  it('keeps a workspace validation failure authoritative when its snapshot write fails', async () => {
    await withTempRoot(async (rootDir) => {
      const validation = createTask({
        id: 'workspace-validation',
        issues: [
          createIssue({
            code: 'LIMINA_WORKSPACE_REGION_OVERLAP',
            task: 'workspace:validate',
          }),
        ],
        order: 0,
        passed: false,
      });
      validation.issueTask = 'workspace:validate';
      validation.kind = 'preparation';
      validation.label = 'workspace:validate';
      const { chunks, flow } = createBufferedTtyFlow();
      const writeCheck = vi.fn(async () => {
        throw new Error('snapshot storage unavailable');
      });
      const writeSource = vi.fn(async () => {});

      const result = await runExecutionTasks({
        command: 'limina check',
        flow,
        preflight: createPreflight(rootDir),
        rootDir,
        snapshotWriters: { writeCheck, writeSource },
        tasks: [validation],
      });

      expect(result.passed).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: 'LIMINA_WORKSPACE_REGION_OVERLAP',
          task: 'workspace:validate',
        }),
      ]);
      expect(writeCheck).toHaveBeenCalledOnce();
      expect(writeSource).not.toHaveBeenCalled();
      expect(chunks.join('')).toContain(
        'the original check failure remains authoritative',
      );
    });
  });

  it('joins already running work before returning a stop-policy result', async () => {
    await withTempRoot(async (rootDir) => {
      let joined = false;
      const longRunning = createTask({
        delayMs: 30,
        id: 'running',
        onRun: () => {
          setTimeout(() => {
            joined = true;
          }, 25);
        },
        order: 0,
      });
      const command = createTask({
        failPolicy: 'stop-pipeline',
        id: 'command',
        order: 1,
        passed: false,
      });
      command.kind = 'command';
      command.issueTask = 'command';

      await runExecutionTasks({
        command: 'limina check demo',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [longRunning, command],
      });
      expect(joined).toBe(true);
    });
  });

  it('keeps a runner behind the start gate until projections succeed', async () => {
    await withTempRoot(async (rootDir) => {
      let runnerStarted = false;
      const task = createTask({
        id: 'gated',
        onRun: () => {
          runnerStarted = true;
        },
        order: 0,
      });
      const recorder = createCheckRunRecorder({
        command: 'limina check',
        plannedTasks: [task],
        rootDir,
      });
      const originalProject = recorder.project;
      recorder.project = (identity, event) => {
        if (event.type === 'start') expect(runnerStarted).toBe(false);
        originalProject(identity, event);
      };

      await runExecutionTasks({
        checkRunRecorder: recorder,
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [task],
      });
      expect(runnerStarted).toBe(true);
    });
  });

  it('aborts an unstarted runner and joins existing work on recorder projection failure', async () => {
    await withTempRoot(async (rootDir) => {
      let firstJoined = false;
      let secondStarted = false;
      const first = createTask({
        delayMs: 30,
        id: 'first',
        onRun: () => {
          setTimeout(() => {
            firstJoined = true;
          }, 25);
        },
        order: 0,
      });
      const second = createTask({
        id: 'second',
        onRun: () => {
          secondStarted = true;
        },
        order: 1,
      });
      const recorder = createCheckRunRecorder({
        command: 'limina check',
        plannedTasks: [first, second],
        rootDir,
      });
      const originalProject = recorder.project;
      recorder.project = (identity, event) => {
        if (identity.id === second.id && event.type === 'start') {
          throw new Error('recorder start projection failed');
        }
        originalProject(identity, event);
      };

      await expect(
        runExecutionTasks({
          checkRunRecorder: recorder,
          command: 'limina check',
          preflight: createPreflight(rootDir),
          rootDir,
          tasks: [first, second],
        }),
      ).rejects.toThrow('recorder start projection failed');
      expect(firstJoined).toBe(true);
      expect(secondStarted).toBe(false);
      expect(await readCheckIssueSnapshot(rootDir)).toBeNull();
      expect(
        recorder
          .getRunSummary()
          .tasks.some((entry) => entry.state === 'running'),
      ).toBe(false);
    });
  });

  it('does not lose or start a runner when flow start projection fails', async () => {
    await withTempRoot(async (rootDir) => {
      let runnerStarted = false;
      let cleanupFailed = false;
      const task = createTask({
        id: 'flow-failure',
        onRun: () => {
          runnerStarted = true;
        },
        order: 0,
      });
      const node = {
        block() {},
        child() {
          return node;
        },
        children() {
          return [];
        },
        fail() {
          cleanupFailed = true;
        },
        pass() {},
        skip() {},
        start() {
          throw new Error('flow start projection failed');
        },
      };
      const flow = { tree: () => node } as unknown as LiminaFlowReporter;

      await expect(
        runExecutionTasks({
          command: 'limina check',
          flow,
          preflight: createPreflight(rootDir),
          rootDir,
          tasks: [task],
        }),
      ).rejects.toThrow('flow start projection failed');
      expect(runnerStarted).toBe(false);
      expect(cleanupFailed).toBe(true);
      expect(await readCheckIssueSnapshot(rootDir)).toBeNull();
    });
  });

  it('blocks remaining ordered work after a block-policy failure', async () => {
    await withTempRoot(async (rootDir) => {
      const tasks = [
        createTask({
          failPolicy: 'stop-pipeline',
          id: 'a',
          order: 0,
          passed: false,
        }),
        createTask({ after: ['a'], id: 'b', order: 1 }),
      ];
      const recorder = createCheckRunRecorder({
        command: 'limina check demo',
        plannedTasks: tasks,
        rootDir,
      });
      const result = await runExecutionTasks({
        checkRunRecorder: recorder,
        command: 'limina check demo',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks,
      });
      const snapshot = await readCheckIssueSnapshot(rootDir);

      expect(result.results.map((taskResult) => taskResult.status)).toEqual([
        'failed',
        'skipped',
      ]);
      expect(snapshot?.run?.result).toBe('blocked');
      expect(snapshot?.run?.tasks.map((task) => task.state)).toEqual([
        'failed',
        'skipped',
      ]);
    });
  });

  it('starts a new generation after repository-mutating tasks finish', async () => {
    await withTempRoot(async (rootDir) => {
      const preflight = createPreflight(rootDir);
      const command = createTask({
        id: 'a',
        invalidatesPreflight: true,
        order: 0,
      });
      command.failPolicy = 'stop-pipeline';
      command.kind = 'command';
      await runExecutionTasks({
        command: 'limina check',
        preflight,
        rootDir,
        tasks: [command],
      });

      expect(preflight.run.generation).toBe('1');
    });
  });

  it('rejects runtime generation drift before lock acquisition or runner start', async () => {
    await withTempRoot(async (rootDir) => {
      const preflight = createPreflight(rootDir);
      createPreflightGenerationController(preflight).startNextGeneration();
      let runnerStarted = false;
      const task = createTask({
        id: 'stale',
        onRun: () => {
          runnerStarted = true;
        },
        order: 0,
        resources: { write: ['repository'] },
      });
      const recorder = createCheckRunRecorder({
        command: 'limina check',
        plannedTasks: [task],
        rootDir,
      });
      const acquire = vi.spyOn(ResourceLockSet.prototype, 'acquire');

      try {
        await expect(
          runExecutionTasks({
            checkRunRecorder: recorder,
            command: 'limina check',
            preflight,
            rootDir,
            tasks: [task],
          }),
        ).rejects.toThrow('active repository generation is 1');
        expect(runnerStarted).toBe(false);
        expect(acquire).not.toHaveBeenCalled();
        expect(recorder.getRunSummary().tasks[0]?.state).toBe('planned');
        expect(preflight.run.generation).toBe('1');
        expect(await readCheckIssueSnapshot(rootDir)).toBeNull();
      } finally {
        acquire.mockRestore();
      }
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

  it.each([
    { issues: [] as SourceCheckIssue[], label: 'empty' },
    {
      issues: [
        {
          code: SOURCE_ISSUE_CODES.unusedModule,
          filePath: '/workspace/src/unused.ts',
          ownerName: '@fixture/pkg',
        } as SourceCheckIssue,
      ],
      label: 'non-empty',
    },
  ])('writes an authoritative $label source snapshot', async ({ issues }) => {
    await withTempRoot(async (rootDir) => {
      const source = createTask({ id: 'source', order: 0 });
      source.issueTask = 'source:check';
      source.label = 'source:check';
      source.run = async () => ({
        issues: [],
        sourceSnapshot: { issues, status: 'completed' },
        status: issues.length === 0 ? 'passed' : 'failed',
      });

      await runExecutionTasks({
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [source],
      });
      expect(await readSourceIssueSnapshot(rootDir)).toMatchObject({
        issues: issues.map((issue) => ({
          code: issue.code,
          ownerName: issue.ownerName,
        })),
        status: 'completed',
      });
      expect((await readCheckIssueSnapshot(rootDir))?.issues).toHaveLength(
        issues.length,
      );
    });
  });

  it.each([
    { commandPassed: true, label: 'successful' },
    { commandPassed: false, label: 'failed' },
  ])(
    'invalidates source inventory after a $label terminal command while preserving issues',
    async ({ commandPassed }) => {
      await withTempRoot(async (rootDir) => {
        const sourceIssue: SourceCheckIssue = {
          code: SOURCE_ISSUE_CODES.unusedModule,
          filePath: path.join(rootDir, 'src/old-generation.ts'),
          ownerDirectory: rootDir,
          ownerName: '@fixture/pkg',
          packageJsonPath: path.join(rootDir, 'package.json'),
        };
        const source = createTask({ id: 'source', order: 0 });
        source.issueTask = 'source:check';
        source.label = 'source:check';
        source.run = async () => ({
          issues: [],
          sourceSnapshot: { issues: [sourceIssue], status: 'completed' },
          status: 'failed',
        });
        const command = asAdvancementCommand(
          createTask({
            after: ['source'],
            id: 'command',
            order: 1,
            passed: commandPassed,
          }),
        );
        const preflight = createPreflight(rootDir);

        await runExecutionTasks({
          command: 'limina check',
          preflight,
          rootDir,
          tasks: [source, command],
        });

        expect(preflight.run.generation).toBe('1');
        expect(await readSourceIssueSnapshot(rootDir)).toMatchObject({
          issues: [],
          status: 'not-run',
        });
        expect((await readCheckIssueSnapshot(rootDir))?.issues).toEqual([
          expect.objectContaining({
            code: SOURCE_ISSUE_CODES.unusedModule,
            task: 'source:check',
          }),
        ]);
      });
    },
  );

  it('commits only the last source occurrence when it matches final generation', async () => {
    await withTempRoot(async (rootDir) => {
      const oldIssue: SourceCheckIssue = {
        code: SOURCE_ISSUE_CODES.unusedModule,
        filePath: path.join(rootDir, 'src/old-generation.ts'),
        ownerDirectory: rootDir,
        ownerName: '@fixture/pkg',
        packageJsonPath: path.join(rootDir, 'package.json'),
      };
      const firstSource = createTask({ id: 'source-0', order: 0 });
      firstSource.issueTask = 'source:check';
      firstSource.label = 'source:check';
      firstSource.run = async () => ({
        issues: [],
        sourceSnapshot: { issues: [oldIssue], status: 'completed' },
        status: 'failed',
      });
      const command = asAdvancementCommand(
        createTask({ after: ['source-0'], id: 'command', order: 1 }),
      );
      const finalSource = createTask({
        after: ['command'],
        generation: 1,
        id: 'source-1',
        order: 2,
      });
      finalSource.issueTask = 'source:check';
      finalSource.label = 'source:check';
      finalSource.run = async () => ({
        issues: [],
        sourceSnapshot: { issues: [], status: 'completed' },
        status: 'passed',
      });
      const preflight = createPreflight(rootDir);

      await runExecutionTasks({
        command: 'limina check',
        preflight,
        rootDir,
        tasks: [firstSource, command, finalSource],
      });

      expect(preflight.run.generation).toBe('1');
      expect(await readSourceIssueSnapshot(rootDir)).toMatchObject({
        issues: [],
        status: 'completed',
      });
      expect((await readCheckIssueSnapshot(rootDir))?.issues).toEqual([
        expect.objectContaining({
          code: SOURCE_ISSUE_CODES.unusedModule,
          task: 'source:check',
        }),
      ]);
    });
  });

  it('keeps final-generation source authority across non-invalidating work', async () => {
    await withTempRoot(async (rootDir) => {
      const source = createTask({ id: 'source', order: 0 });
      source.issueTask = 'source:check';
      source.label = 'source:check';
      source.run = async () => ({
        issues: [],
        sourceSnapshot: { issues: [], status: 'completed' },
        status: 'passed',
      });

      await runExecutionTasks({
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [
          source,
          createTask({ after: ['source'], id: 'proof', order: 1 }),
        ],
      });

      expect(await readSourceIssueSnapshot(rootDir)).toMatchObject({
        status: 'completed',
      });
    });
  });

  it('writes not-run when source analysis fails before producing authority', async () => {
    await withTempRoot(async (rootDir) => {
      const source = createTask({ id: 'source', order: 0, passed: false });
      source.issueTask = 'source:check';
      source.label = 'source:check';
      await runExecutionTasks({
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [source],
      });
      expect(await readSourceIssueSnapshot(rootDir)).toMatchObject({
        issues: [],
        status: 'not-run',
      });
    });
  });

  it('writes not-run when a source task is skipped by stop policy', async () => {
    await withTempRoot(async (rootDir) => {
      const command = createTask({
        failPolicy: 'stop-pipeline',
        id: 'command',
        order: 0,
        passed: false,
      });
      command.kind = 'command';
      command.issueTask = 'command';
      const source = createTask({ after: ['command'], id: 'source', order: 1 });
      source.issueTask = 'source:check';
      source.label = 'source:check';

      await runExecutionTasks({
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [command, source],
      });
      expect(await readSourceIssueSnapshot(rootDir)).toMatchObject({
        status: 'not-run',
      });
    });
  });

  it('does not touch an existing source snapshot when the plan has no source task', async () => {
    await withTempRoot(async (rootDir) => {
      await writeSourceIssueSnapshotOnly(
        createLiminaArtifactNamespace({ generation: 0, rootDir }),
        {
          command: 'previous',
          createdAt: '2026-07-14T00:00:00.000Z',
          issues: [
            {
              code: SOURCE_ISSUE_CODES.unusedModule,
              ownerName: '@fixture/old',
            },
          ],
          status: 'completed',
          version: 1,
        },
      );
      await runExecutionTasks({
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [createTask({ id: 'graph', order: 0 })],
      });
      expect(await readSourceIssueSnapshot(rootDir)).toMatchObject({
        command: 'previous',
        issues: [{ ownerName: '@fixture/old' }],
      });
    });
  });

  it('does not commit completed check state when the source writer fails', async () => {
    await withTempRoot(async (rootDir) => {
      const source = createTask({ id: 'source', order: 0 });
      source.issueTask = 'source:check';
      source.label = 'source:check';
      source.run = async () => ({
        issues: [],
        sourceSnapshot: { issues: [], status: 'completed' },
        status: 'passed',
      });
      await writeNotRunCheckIssueSnapshot({
        artifactNamespace: createLiminaArtifactNamespace({
          generation: 0,
          rootDir,
        }),
        command: 'limina check',
        rootDir,
      });
      await rm(getSourceIssueSnapshotPath(rootDir), {
        force: true,
        recursive: true,
      });
      await mkdir(getSourceIssueSnapshotPath(rootDir), { recursive: true });

      await expect(
        runExecutionTasks({
          command: 'limina check',
          preflight: createPreflight(rootDir),
          rootDir,
          tasks: [source],
        }),
      ).rejects.toBeDefined();
      expect(await readCheckIssueSnapshot(rootDir)).toMatchObject({
        status: 'not-run',
      });
    });
  });

  it('keeps the source snapshot when the following check write fails', async () => {
    await withTempRoot(async (rootDir) => {
      const sourceIssue: SourceCheckIssue = {
        code: SOURCE_ISSUE_CODES.unusedModule,
        filePath: path.join(rootDir, 'src/unused.ts'),
        ownerDirectory: rootDir,
        ownerName: '@fixture/pkg',
        packageJsonPath: path.join(rootDir, 'package.json'),
      };
      const source = createTask({ id: 'source', order: 0 });
      source.issueTask = 'source:check';
      source.label = 'source:check';
      source.run = async () => ({
        issues: [],
        sourceSnapshot: { issues: [sourceIssue], status: 'completed' },
        status: 'failed',
      });
      const writeCheck = vi.fn(async () => {
        throw new Error('injected check snapshot write failure');
      });

      const executionResult = await runExecutionTasks({
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        snapshotWriters: {
          writeCheck,
          writeSource: writeSourceIssueSnapshotOnly,
        },
        tasks: [source],
      });

      expect(executionResult.passed).toBe(false);
      expect(writeCheck).toHaveBeenCalledOnce();
      await expect(access(getSourceIssueSnapshotPath(rootDir))).resolves.toBe(
        undefined,
      );
      await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();

      await writeFile(
        path.join(rootDir, 'limina.config.mjs'),
        'export default {};\n',
      );
      await writeFile(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      const cliPath = fileURLToPath(
        new URL('../../bin/limina.js', import.meta.url),
      );
      const cliResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
        ],
        {
          cwd: rootDir,
          env: { ...process.env, CI: 'true' },
        },
      );

      expect(cliResult.stdout).toContain('No check issue snapshot found.');
      expect(cliResult.stdout).not.toContain(SOURCE_ISSUE_CODES.unusedModule);
      await expect(readSourceIssueSnapshot(rootDir)).resolves.toMatchObject({
        issues: [
          {
            code: SOURCE_ISSUE_CODES.unusedModule,
            ownerName: '@fixture/pkg',
          },
        ],
        status: 'completed',
        version: 1,
      });
    });
  }, 40_000);

  it('keeps check not-run until the authoritative source write settles', async () => {
    await withTempRoot(async (rootDir) => {
      const source = createTask({ id: 'source', order: 0 });
      source.issueTask = 'source:check';
      source.label = 'source:check';
      source.run = async () => ({
        issues: [],
        sourceSnapshot: { issues: [], status: 'completed' },
        status: 'passed',
      });
      await writeNotRunCheckIssueSnapshot({
        artifactNamespace: createLiminaArtifactNamespace({
          generation: 0,
          rootDir,
        }),
        command: 'limina check',
        rootDir,
      });
      const writes: string[] = [];

      await runExecutionTasks({
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        snapshotWriters: {
          async writeCheck(namespace, snapshot) {
            writes.push(`check:${snapshot.status}`);
            await writeCheckIssueSnapshotOnly(namespace, snapshot);
          },
          async writeSource(namespace, snapshot) {
            writes.push(`source:${snapshot.status}`);
            await writeSourceIssueSnapshotOnly(namespace, snapshot);
            expect(await readCheckIssueSnapshot(rootDir)).toMatchObject({
              status: 'not-run',
            });
          },
        },
        tasks: [source],
      });

      expect(writes).toEqual(['source:completed', 'check:completed']);
      expect(await readCheckIssueSnapshot(rootDir)).toMatchObject({
        status: 'completed',
      });
    });
  });
});

describe('checker target snapshot projection', () => {
  it('preserves CheckerTargetId and root blocker identity inside one execution task', async () => {
    await withTempRoot(async (rootDir) => {
      const providerId = createCheckerTargetId(['test', 'provider']);
      const consumerId = createCheckerTargetId(['test', 'consumer']);
      const task: ExecutionTask = {
        failPolicy: 'continue',
        generation: 0,
        id: taskId('execution:checker-build'),
        issueTask: 'checker:build',
        kind: 'task',
        label: 'checker:build',
        order: 0,
        resources: {},
        run: async () => ({
          issues: [],
          stats: {
            items: [
              {
                ...createCheckItemStats({
                  issues: 1,
                  name: 'provider',
                  total: 1,
                }),
                id: providerId,
                itemKind: 'checker-target',
                status: 'failed',
              },
              {
                ...createCheckItemStats({
                  issues: 1,
                  name: 'consumer',
                  total: 1,
                }),
                blockedBy: [{ id: providerId, name: 'provider' }],
                id: consumerId,
                itemKind: 'checker-target',
                status: 'blocked',
              },
            ],
            passed: 0,
            total: 2,
          },
          status: 'failed',
        }),
      };
      const recorder = createCheckRunRecorder({
        command: 'limina check',
        plannedTasks: [task],
        rootDir,
      });

      await runExecutionTasks({
        checkRunRecorder: recorder,
        command: 'limina check',
        preflight: createPreflight(rootDir),
        rootDir,
        tasks: [task],
      });

      const snapshot = await readCheckIssueSnapshot(rootDir);
      expect(snapshot?.run?.tasks).toHaveLength(1);
      expect(snapshot?.run?.tasks[0]?.id).toBe(task.id);
      expect(snapshot?.run?.tasks[0]?.checkItems?.[1]).toMatchObject({
        blockedBy: [{ id: providerId, name: 'provider' }],
        id: consumerId,
        status: 'blocked',
      });
    });
  });
});

describe('execution task lifecycle guard', () => {
  it('accepts only the declared planned/running terminal transitions', () => {
    expect(
      transitionTask('planned', {
        startedAt: '2026-07-14T00:00:00.000Z',
        type: 'start',
      }),
    ).toBe('running');
    expect(
      transitionTask('running', {
        completedAt: '2026-07-14T00:00:01.000Z',
        durationMs: 1000,
        type: 'pass',
      }),
    ).toBe('passed');
    expect(
      transitionTask('running', {
        completedAt: '2026-07-14T00:00:01.000Z',
        durationMs: 1000,
        type: 'fail',
      }),
    ).toBe('failed');
    expect(
      transitionTask('planned', {
        blockedBy: { id: taskId('provider'), label: 'provider' },
        type: 'block',
      }),
    ).toBe('blocked');
    expect(
      transitionTask('planned', { reason: 'stop policy', type: 'skip' }),
    ).toBe('skipped');
  });

  it('rejects running to blocked and every terminal restart', () => {
    expect(() =>
      transitionTask('running', {
        blockedBy: { id: taskId('provider'), label: 'provider' },
        type: 'block',
      }),
    ).toThrow(/Invalid execution task transition/u);
    for (const terminal of [
      'passed',
      'failed',
      'blocked',
      'skipped',
    ] as const) {
      expect(() =>
        transitionTask(terminal, {
          startedAt: '2026-07-14T00:00:00.000Z',
          type: 'start',
        }),
      ).toThrow(/Invalid execution task transition/u);
    }
  });
});
