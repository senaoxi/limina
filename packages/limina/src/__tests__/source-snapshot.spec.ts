import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'pathe';
import { describe, expect, it } from 'vitest';
import {
  appendCheckIssues,
  CHECK_ISSUE_SNAPSHOT_VERSION,
  type CheckIssueSnapshot,
  completeCheckIssueSnapshot,
  formatCheckIssueSnapshotInventory,
  getCheckIssueSnapshotPath,
  type LiminaCheckRunSummary,
  readCheckIssueSnapshot,
  writeCheckIssueSnapshotOnly,
  writeNotRunCheckIssueSnapshot,
} from '../check-reporting/snapshot';
import { createLiminaCheckIssue } from '../check-reporting/structured';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { SOURCE_ISSUE_CODES } from '../source-check/report';
import {
  formatSourceIssueSnapshotInventory,
  SOURCE_ISSUE_SNAPSHOT_VERSION,
  type SourceIssueSnapshot,
} from '../source-check/snapshot';
import { createCheckerTargetId } from '../typecheck/targets';

const ANSI_ESCAPE = String.fromCodePoint(0x1b);
const ANSI_PATTERN = new RegExp(
  String.raw`${ANSI_ESCAPE}\[[\d:;<=>?]*[\u0020-\u002F]*[\u0040-\u007E]`,
  'gu',
);

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_PATTERN, '');
}

function createSnapshot(
  issues: SourceIssueSnapshot['issues'],
): SourceIssueSnapshot {
  return {
    command: 'limina check',
    createdAt: '2026-06-19T00:00:00.000Z',
    issues,
    status: 'completed',
    version: SOURCE_ISSUE_SNAPSHOT_VERSION,
  };
}

function createCheckSnapshot(
  issues: CheckIssueSnapshot['issues'],
): CheckIssueSnapshot {
  return {
    command: 'limina check',
    createdAt: '2026-06-19T00:00:00.000Z',
    issues,
    status: 'completed',
    version: CHECK_ISSUE_SNAPSHOT_VERSION,
  };
}

async function writeRawCheckSnapshot(
  rootDir: string,
  snapshot: unknown,
): Promise<void> {
  const snapshotPath = getCheckIssueSnapshotPath(rootDir);
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

function createCompletedRun(
  tasks: LiminaCheckRunSummary['tasks'] = [
    {
      completedAt: '2026-06-20T00:00:01.000Z',
      durationMs: 1000,
      generation: 0,
      id: 'task:proof',
      issueTask: 'proof:check',
      kind: 'task',
      label: 'proof:check',
      startedAt: '2026-06-20T00:00:00.000Z',
      state: 'passed',
    },
  ],
  result: LiminaCheckRunSummary['result'] = 'passed',
): LiminaCheckRunSummary {
  return {
    command: 'limina check',
    completedAt: '2026-06-20T00:00:01.000Z',
    createdAt: '2026-06-20T00:00:00.000Z',
    durationMs: 1000,
    result,
    startedAt: '2026-06-20T00:00:00.000Z',
    tasks,
  };
}

function createCheckerCompletedRun(): {
  ids: { consumer: string; rootA: string; rootB: string };
  run: LiminaCheckRunSummary;
} {
  const ids = {
    consumer: createCheckerTargetId(['consumer']),
    rootA: createCheckerTargetId(['root-a']),
    rootB: createCheckerTargetId(['root-b']),
  };
  return {
    ids,
    run: createCompletedRun(
      [
        {
          checkItems: [
            {
              id: ids.rootA,
              itemKind: 'checker-target',
              name: 'root A',
              status: 'failed',
            },
            {
              id: ids.rootB,
              itemKind: 'checker-target',
              name: 'root B',
              status: 'failed',
            },
            {
              blockedBy: [
                { id: ids.rootA, name: 'root A' },
                { id: ids.rootB, name: 'root B' },
              ],
              id: ids.consumer,
              itemKind: 'checker-target',
              name: 'consumer',
              status: 'blocked',
            },
          ],
          completedAt: '2026-06-20T00:00:01.000Z',
          durationMs: 1000,
          generation: 0,
          id: 'task:checker-build',
          issueTask: 'checker:build',
          kind: 'task',
          label: 'checker:build',
          startedAt: '2026-06-20T00:00:00.000Z',
          state: 'failed',
        },
      ],
      'failed',
    ),
  };
}

function createBlockedRun(
  syntheticState: 'blocked' | 'skipped' = 'blocked',
): LiminaCheckRunSummary {
  const failedTask = {
    completedAt: '2026-06-20T00:00:01.000Z',
    durationMs: 1000,
    generation: 0,
    id: 'task:command',
    issueTask: 'command' as const,
    kind: 'command' as const,
    label: 'failed command',
    startedAt: '2026-06-20T00:00:00.000Z',
    state: 'failed' as const,
  };
  return {
    ...createCompletedRun(
      [
        failedTask,
        {
          ...(syntheticState === 'blocked'
            ? { blockedBy: { id: failedTask.id, label: failedTask.label } }
            : { reason: 'skipped by stop policy' }),
          generation: 0,
          id: 'task:synthetic',
          issueTask: 'proof:check',
          kind: 'task',
          label: 'synthetic task',
          state: syntheticState,
        },
      ],
      'blocked',
    ),
    blockedBy: { id: failedTask.id, label: failedTask.label },
  };
}

describe('source issue snapshots', () => {
  it('migrates every v5 skipped task conservatively without blocker ids', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));
    const snapshotPath = getCheckIssueSnapshotPath(rootDir);

    try {
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(
        snapshotPath,
        `${JSON.stringify({
          command: 'limina check demo',
          createdAt: '2026-06-20T00:00:00.000Z',
          issues: [],
          run: {
            command: 'limina check demo',
            createdAt: '2026-06-20T00:00:00.000Z',
            result: 'blocked',
            tasks: [
              { kind: 'command', name: 'same', status: 'failed' },
              {
                blockedBy: 'same',
                kind: 'command',
                name: 'same',
                status: 'skipped',
              },
              { kind: 'task', name: 'proof:check', status: 'skipped' },
            ],
          },
          status: 'completed',
          version: 5,
        })}\n`,
      );

      const migrated = await readCheckIssueSnapshot(rootDir);
      expect(migrated?.version).toBe(7);
      expect(migrated?.run?.tasks.map((task) => task.state)).toEqual([
        'failed',
        'skipped',
        'skipped',
      ]);
      expect(migrated?.run?.tasks[1]).toMatchObject({
        reason: 'Legacy v5 run: skipped after "same"',
      });
      expect(migrated?.run?.tasks[2]).toMatchObject({
        reason: 'Legacy v5 run: skipped',
      });
      expect(migrated?.run?.tasks[1]).not.toHaveProperty('blockedBy');
      expect(migrated?.run?.tasks[2]).not.toHaveProperty('blockedBy');
      expect(migrated?.run?.tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            generation: 0,
            id: expect.stringMatching(/^legacy-v5:/u),
          }),
        ]),
      );
      expect(migrated?.run?.tasks[0]).not.toHaveProperty('startedAt');
      expect(migrated?.run?.tasks[0]).not.toHaveProperty('completedAt');
      expect(migrated?.run?.tasks[0]).not.toHaveProperty('durationMs');
      expect(
        formatCheckIssueSnapshotInventory({ snapshot: migrated }),
      ).not.toMatch(/generation\s+0/iu);
      expect(
        migrated?.run?.tasks.some((task) => task.state === 'blocked'),
      ).toBe(false);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('formats available filters from the last run in count order', () => {
    const output = formatSourceIssueSnapshotInventory(
      createSnapshot([
        {
          code: SOURCE_ISSUE_CODES.unusedModule,
          filePath: 'packages/app/src/theme/button.ts',
          ownerName: '@example/app',
        },
        {
          code: SOURCE_ISSUE_CODES.unusedModule,
          filePath: 'packages/app/src/theme/card.ts',
          ownerName: '@example/app',
        },
        {
          code: SOURCE_ISSUE_CODES.unusedWorkspaceDependency,
          ownerName: '@example/app',
        },
        {
          code: SOURCE_ISSUE_CODES.unusedModule,
          filePath: 'packages/shared/src/index.ts',
          ownerName: '@example/shared',
        },
      ]),
    );

    expect(output).toContain('Issue filters available from last run:');
    expect(output).toContain('packages:\n  - @example/app  3 issues');
    expect(output).toContain('  - @example/shared  1 issue');
    expect(output).toContain(
      `rules:\n  - ${SOURCE_ISSUE_CODES.unusedModule}  3 issues`,
    );
    expect(output).toContain(
      `  - ${SOURCE_ISSUE_CODES.unusedWorkspaceDependency}  1 issue`,
    );
    expect(output).toContain('scopes:\n  - packages/app/src/theme  2 issues');
    expect(output).toContain('  - packages/shared/src  1 issue');
  });

  it('formats empty and unavailable snapshots', () => {
    expect(formatSourceIssueSnapshotInventory(null)).toContain(
      'No source issue snapshot found.',
    );
    expect(
      formatSourceIssueSnapshotInventory({
        ...createSnapshot([]),
        status: 'not-run',
      }),
    ).toContain('No completed source issue snapshot is available');
    expect(formatSourceIssueSnapshotInventory(createSnapshot([]))).toContain(
      'The last source check completed without structured source issues.',
    );
  });
});

describe('check issue snapshots', () => {
  it('migrates valid v5 check items only as ordinary check items', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));

    try {
      await writeRawCheckSnapshot(rootDir, {
        command: 'limina check',
        createdAt: '2026-06-20T00:00:00.000Z',
        issues: [],
        run: {
          command: 'limina check',
          createdAt: '2026-06-20T00:00:00.000Z',
          result: 'failed',
          tasks: [
            {
              checkItems: [
                {
                  checksPassed: 1,
                  checksTotal: 2,
                  durationMs: 5,
                  issues: 1,
                  name: 'ordinary validation',
                  status: 'failed',
                  unknown: 'discard me',
                },
                { name: '', status: 'passed' },
                { name: 'negative stats', status: 'passed', checksTotal: -1 },
              ],
              kind: 'task',
              name: 'proof:check',
              status: 'failed',
            },
          ],
        },
        status: 'completed',
        version: 5,
      });

      const migrated = await readCheckIssueSnapshot(rootDir);
      expect(migrated?.run?.tasks[0]?.checkItems).toEqual([
        {
          checksPassed: 1,
          checksTotal: 2,
          durationMs: 5,
          issues: 1,
          itemKind: 'check',
          name: 'ordinary validation',
          status: 'failed',
        },
        {
          itemKind: 'check',
          name: 'negative stats',
          status: 'passed',
        },
      ]);
      expect(migrated?.run?.tasks[0]?.checkItems?.[0]).not.toHaveProperty('id');
      expect(migrated?.run?.tasks[0]?.checkItems?.[0]).not.toHaveProperty(
        'blockedBy',
      );
      expect(migrated?.run?.tasks[0]).toMatchObject({
        generation: 0,
        id: 'legacy-v5:0',
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it.each([
    [
      'result disagrees with task state',
      (run: LiminaCheckRunSummary) => {
        run.result = 'passed';
        run.tasks[0]!.state = 'failed';
      },
    ],
    [
      'run timing is incomplete',
      (run: LiminaCheckRunSummary) => {
        delete run.completedAt;
      },
    ],
    [
      'a task remains planned',
      (run: LiminaCheckRunSummary) => {
        run.tasks[0]!.state = 'planned';
        delete run.tasks[0]!.startedAt;
        delete run.tasks[0]!.completedAt;
        delete run.tasks[0]!.durationMs;
      },
    ],
  ] as const)('rejects current v6 completed when %s', async (_name, mutate) => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));
    const run = createCompletedRun();
    mutate(run);

    try {
      await writeRawCheckSnapshot(rootDir, {
        ...createCheckSnapshot([]),
        run,
      });
      await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('routes v6 not-run, standalone completed, and legacy v5 independently', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));

    try {
      await writeRawCheckSnapshot(rootDir, {
        ...createCheckSnapshot([]),
        run: {
          command: 'limina check',
          createdAt: '2026-06-20T00:00:00.000Z',
          result: 'not-run',
          tasks: [
            {
              generation: 0,
              id: 'task:proof',
              issueTask: 'proof:check',
              kind: 'task',
              label: 'proof:check',
              state: 'planned',
            },
          ],
        },
        status: 'not-run',
      });
      await expect(readCheckIssueSnapshot(rootDir)).resolves.toMatchObject({
        run: { result: 'not-run', tasks: [{ state: 'planned' }] },
      });

      await writeRawCheckSnapshot(rootDir, createCheckSnapshot([]));
      const standalone = await readCheckIssueSnapshot(rootDir);
      expect(standalone).toMatchObject({ status: 'completed' });
      expect(standalone).not.toHaveProperty('run');

      await writeRawCheckSnapshot(rootDir, {
        ...createCheckSnapshot([]),
        run: {
          command: 'limina check',
          createdAt: '2026-06-20T00:00:00.000Z',
          result: 'failed',
          tasks: [
            {
              generation: 0,
              id: 'legacy-v5:forged',
              issueTask: 'proof:check',
              kind: 'task',
              label: 'proof:check',
              state: 'failed',
            },
          ],
        },
      });
      await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('rejects invalid current writer models before replacing the snapshot', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));
    const invalidRun = createCompletedRun();
    delete invalidRun.tasks[0]!.completedAt;

    try {
      await expect(
        writeCheckIssueSnapshotOnly(artifactNamespace(rootDir), {
          ...createCheckSnapshot([]),
          run: invalidRun,
        }),
      ).rejects.toThrow('Invalid completed check run summary');
      await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it.each([
    [
      'passed run carries a blocker',
      () => {
        const run = createCompletedRun();
        run.blockedBy = { id: run.tasks[0]!.id, label: run.tasks[0]!.label };
        return run;
      },
    ],
    [
      'failed run has no failed task',
      () => {
        const run = createCompletedRun();
        run.result = 'failed';
        return run;
      },
    ],
    [
      'failed run contains a blocked task',
      () => {
        const run = createBlockedRun();
        run.result = 'failed';
        delete run.blockedBy;
        return run;
      },
    ],
    [
      'failed run carries a blocker',
      () => {
        const run = createCompletedRun();
        run.tasks[0]!.state = 'failed';
        run.result = 'failed';
        run.blockedBy = { id: run.tasks[0]!.id, label: run.tasks[0]!.label };
        return run;
      },
    ],
    [
      'blocked run has no synthetic task',
      () => {
        const run = createCompletedRun();
        run.tasks[0]!.state = 'failed';
        run.result = 'blocked';
        run.blockedBy = { id: run.tasks[0]!.id, label: run.tasks[0]!.label };
        return run;
      },
    ],
    [
      'blocked run is missing run blocker',
      () => {
        const run = createBlockedRun('skipped');
        delete run.blockedBy;
        return run;
      },
    ],
    [
      'run blocker is unknown',
      () => {
        const run = createBlockedRun();
        run.blockedBy = { id: 'task:missing', label: 'missing' };
        return run;
      },
    ],
    [
      'run blocker label is stale',
      () => {
        const run = createBlockedRun();
        run.blockedBy = { ...run.blockedBy!, label: 'wrong label' };
        return run;
      },
    ],
    [
      'task ids are duplicated',
      () => {
        const run = createBlockedRun();
        run.tasks[1]!.id = run.tasks[0]!.id;
        return run;
      },
    ],
    [
      'task generation is invalid',
      () => {
        const run = createCompletedRun();
        run.tasks[0]!.generation = -1;
        return run;
      },
    ],
  ] as const)(
    'rejects completed run semantics when %s',
    async (_name, createRun) => {
      const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));

      try {
        await writeRawCheckSnapshot(rootDir, {
          ...createCheckSnapshot([]),
          run: createRun(),
        });
        await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();
      } finally {
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );

  it.each([
    ['passed', createCompletedRun()],
    [
      'failed',
      (() => {
        const run = createCompletedRun();
        run.result = 'failed';
        run.tasks[0]!.state = 'failed';
        return run;
      })(),
    ],
    ['blocked', createBlockedRun()],
    ['skipped', createBlockedRun('skipped')],
  ] as const)('accepts a valid %s completed model', async (_name, run) => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));

    try {
      await writeCheckIssueSnapshotOnly(artifactNamespace(rootDir), {
        ...createCheckSnapshot([]),
        run,
      });
      await expect(readCheckIssueSnapshot(rootDir)).resolves.not.toBeNull();
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('prevents current writers from generating legacy v5 task identities', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));
    const run = createCompletedRun();
    run.tasks[0]!.id = 'legacy-v5:forged';

    try {
      await expect(
        writeCheckIssueSnapshotOnly(artifactNamespace(rootDir), {
          ...createCheckSnapshot([]),
          run,
        }),
      ).rejects.toThrow('must not use legacy-v5 task ids');
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('accepts canonical checker target roots within one task occurrence', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));
    const { run } = createCheckerCompletedRun();

    try {
      await writeCheckIssueSnapshotOnly(artifactNamespace(rootDir), {
        ...createCheckSnapshot([]),
        run,
      });
      await expect(readCheckIssueSnapshot(rootDir)).resolves.toMatchObject({
        run: {
          result: 'failed',
          tasks: [
            {
              checkItems: [
                { name: 'root A', status: 'failed' },
                { name: 'root B', status: 'failed' },
                {
                  blockedBy: [{ name: 'root A' }, { name: 'root B' }],
                  name: 'consumer',
                  status: 'blocked',
                },
              ],
            },
          ],
        },
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it.each([
    [
      'duplicate target id',
      (run: LiminaCheckRunSummary) => {
        const items = run.tasks[0]!.checkItems!;
        if (
          items[0]!.itemKind === 'checker-target' &&
          items[1]!.itemKind === 'checker-target'
        ) {
          items[1]!.id = items[0]!.id;
        }
      },
    ],
    [
      'malformed target id',
      (run: LiminaCheckRunSummary) => {
        const item = run.tasks[0]!.checkItems![0]!;
        if (item.itemKind === 'checker-target') {
          item.id = 'task:not-a-checker-id';
        }
      },
    ],
    [
      'unknown blocker',
      (run: LiminaCheckRunSummary) => {
        const consumer = run.tasks[0]!.checkItems![2]!;
        if (consumer.itemKind === 'checker-target') {
          consumer.blockedBy = [
            { id: createCheckerTargetId(['missing']), name: 'missing' },
          ];
        }
      },
    ],
    [
      'self blocker',
      (run: LiminaCheckRunSummary) => {
        const consumer = run.tasks[0]!.checkItems![2]!;
        if (consumer.itemKind === 'checker-target') {
          consumer.blockedBy = [{ id: consumer.id, name: consumer.name }];
        }
      },
    ],
    [
      'passed root',
      (run: LiminaCheckRunSummary) => {
        run.tasks[0]!.checkItems![0]!.status = 'passed';
      },
    ],
    [
      'blocked root',
      (run: LiminaCheckRunSummary) => {
        const items = run.tasks[0]!.checkItems!;
        const root = items[0]!;
        const blocker = items[1]!;
        if (
          root.itemKind === 'checker-target' &&
          blocker.itemKind === 'checker-target'
        ) {
          root.status = 'blocked';
          root.blockedBy = [{ id: blocker.id, name: blocker.name }];
        }
      },
    ],
    [
      'skipped root',
      (run: LiminaCheckRunSummary) => {
        run.tasks[0]!.checkItems![0]!.status = 'skipped';
      },
    ],
    [
      'blocker name mismatch',
      (run: LiminaCheckRunSummary) => {
        const consumer = run.tasks[0]!.checkItems![2]!;
        if (consumer.itemKind === 'checker-target') {
          consumer.blockedBy = [
            { ...consumer.blockedBy![0]!, name: 'wrong name' },
            consumer.blockedBy![1]!,
          ];
        }
      },
    ],
    [
      'duplicate blocker root',
      (run: LiminaCheckRunSummary) => {
        const consumer = run.tasks[0]!.checkItems![2]!;
        if (consumer.itemKind === 'checker-target') {
          consumer.blockedBy = [
            consumer.blockedBy![0]!,
            consumer.blockedBy![0]!,
          ];
        }
      },
    ],
    [
      'noncanonical blocker order',
      (run: LiminaCheckRunSummary) => {
        const consumer = run.tasks[0]!.checkItems![2]!;
        if (consumer.itemKind === 'checker-target') {
          consumer.blockedBy = consumer.blockedBy!.toReversed();
        }
      },
    ],
  ] as const)(
    'rejects checker target relation with %s',
    async (_name, mutate) => {
      const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));
      const { run } = createCheckerCompletedRun();
      mutate(run);

      try {
        await writeRawCheckSnapshot(rootDir, {
          ...createCheckSnapshot([]),
          run,
        });
        await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();
      } finally {
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );

  it('allows the same checker target id in different execution task occurrences', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));
    const repeatedId = createCheckerTargetId(['repeated']);
    const tasks = ['task:first', 'task:second'].map((id, index) => ({
      checkItems: [
        {
          id: repeatedId,
          itemKind: 'checker-target' as const,
          name: 'repeated target',
          status: 'passed' as const,
        },
      ],
      completedAt: `2026-06-20T00:00:0${index + 1}.000Z`,
      durationMs: 1000,
      generation: 0,
      id,
      issueTask: 'checker:build' as const,
      kind: 'task' as const,
      label: `checker build ${index + 1}`,
      startedAt: `2026-06-20T00:00:0${index}.000Z`,
      state: 'passed' as const,
    }));

    try {
      await writeCheckIssueSnapshotOnly(artifactNamespace(rootDir), {
        ...createCheckSnapshot([]),
        run: createCompletedRun(tasks),
      });
      await expect(readCheckIssueSnapshot(rootDir)).resolves.not.toBeNull();
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('keeps task ids and checker target ids in separate identity spaces', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));
    const { ids, run } = createCheckerCompletedRun();
    run.tasks[0]!.id = ids.rootA;

    try {
      await writeRawCheckSnapshot(rootDir, {
        ...createCheckSnapshot([]),
        run,
      });
      await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('normalizes builder paths, derives scope, and creates stable ids', () => {
    const issue = createLiminaCheckIssue({
      code: 'LIMINA_GRAPH_REFERENCE_MISSING',
      filePath: '/repo/packages/app/src/index.ts:12:3',
      reason: 'missing ref',
      rootDir: '/repo',
      task: 'graph:check',
      title: 'Missing project reference',
    });
    const sameIssue = createLiminaCheckIssue({
      code: 'LIMINA_GRAPH_REFERENCE_MISSING',
      filePath: '/repo/packages/app/src/index.ts:12:3',
      reason: 'missing ref',
      rootDir: '/repo',
      task: 'graph:check',
      title: 'Missing project reference',
    });

    expect(issue.filePath).toBe('packages/app/src/index.ts');
    expect(issue.scope).toBe('packages/app/src');
    expect(issue.domain).toBe('graph');
    expect(issue.id).toBe(sameIssue.id);
  });

  it('rejects pre-0.2 snapshots and reads only the current schema', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));

    try {
      const snapshotPath = getCheckIssueSnapshotPath(rootDir);
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(
        snapshotPath,
        `${JSON.stringify(
          {
            ...createCheckSnapshot([
              {
                code: 'LIMINA_PACKAGE_CHECK_FAILED',
                reason: 'package failed',
                task: 'package:check',
                title: 'Package check failed',
              },
            ]),
            version: 1,
          },
          null,
          2,
        )}\n`,
      );

      await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();

      await writeFile(
        snapshotPath,
        `${JSON.stringify(
          {
            ...createCheckSnapshot([
              createLiminaCheckIssue({
                code: 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE',
                filePath: 'packages/app/src/internal.ts',
                reason: 'not covered',
                rootDir,
                task: 'proof:check',
                title: 'Uncovered source file',
              }),
            ]),
            version: 2,
          },
          null,
          2,
        )}\n`,
      );

      await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();

      await writeFile(
        snapshotPath,
        `${JSON.stringify(
          {
            ...createCheckSnapshot([
              createLiminaCheckIssue({
                code: 'LIMINA_GRAPH_REFERENCE_MISSING',
                filePath: 'packages/app/src/index.ts',
                reason: 'missing ref',
                rootDir,
                task: 'graph:check',
                title: 'Missing project reference',
              }),
            ]),
            run: {
              command: 'limina check',
              createdAt: '2026-06-20T00:00:00.000Z',
              result: 'blocked',
              tasks: [
                {
                  kind: 'task',
                  name: 'graph:check',
                  status: 'failed',
                },
              ],
            },
            version: 3,
          },
          null,
          2,
        )}\n`,
      );

      await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();

      await writeFile(
        snapshotPath,
        `${JSON.stringify(
          {
            ...createCheckSnapshot([
              createLiminaCheckIssue({
                code: 'LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED',
                filePath: 'packages/app/src/index.ts',
                reason: 'unauthorized import',
                rootDir,
                task: 'source:check',
                title: 'Unauthorized import',
              }),
            ]),
            run: {
              command: 'limina check',
              createdAt: '2026-06-20T00:00:00.000Z',
              result: 'failed',
              tasks: [
                {
                  checkItems: [
                    {
                      checksPassed: 0,
                      checksTotal: 1,
                      issues: 1,
                      name: 'source import authority',
                      status: 'failed',
                    },
                  ],
                  kind: 'task',
                  name: 'source:check',
                  status: 'failed',
                },
              ],
            },
            version: 5,
          },
          null,
          2,
        )}\n`,
      );

      expect(await readCheckIssueSnapshot(rootDir)).toMatchObject({
        issues: [
          {
            code: 'LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED',
            id: expect.any(String),
          },
        ],
        run: {
          result: 'failed',
          tasks: [
            {
              checkItems: [
                {
                  name: 'source import authority',
                  status: 'failed',
                },
              ],
              label: 'source:check',
              state: 'failed',
            },
          ],
        },
        version: CHECK_ISSUE_SNAPSHOT_VERSION,
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('preserves run metadata and existing issues across append and complete writes', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));
    const firstIssue = createLiminaCheckIssue({
      code: 'LIMINA_GRAPH_REFERENCE_MISSING',
      filePath: 'packages/app/src/index.ts',
      reason: 'missing ref',
      rootDir,
      task: 'graph:check',
      title: 'Missing project reference',
    });
    const secondIssue = createLiminaCheckIssue({
      code: 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE',
      filePath: 'packages/app/src/internal.ts',
      reason: 'not covered',
      rootDir,
      task: 'proof:check',
      title: 'Uncovered source file',
    });

    try {
      await writeNotRunCheckIssueSnapshot({
        artifactNamespace: artifactNamespace(rootDir),
        command: 'limina check',
        rootDir,
        run: {
          command: 'limina check',
          createdAt: '2026-06-20T00:00:00.000Z',
          result: 'not-run',
          tasks: [
            {
              id: 'graph',
              generation: 0,
              issueTask: 'graph:check',
              kind: 'task',
              label: 'graph:check',
              state: 'planned',
            },
            {
              id: 'proof',
              generation: 0,
              issueTask: 'proof:check',
              kind: 'task',
              label: 'proof:check',
              state: 'planned',
            },
          ],
        },
      });

      await appendCheckIssues({
        artifactNamespace: artifactNamespace(rootDir),
        issues: [firstIssue],
        rootDir,
      });

      expect(await readCheckIssueSnapshot(rootDir)).toMatchObject({
        issues: [
          {
            code: 'LIMINA_GRAPH_REFERENCE_MISSING',
          },
        ],
        run: {
          result: 'not-run',
          tasks: [
            {
              kind: 'task',
              label: 'graph:check',
              state: 'planned',
            },
            {
              kind: 'task',
              label: 'proof:check',
              state: 'planned',
            },
          ],
        },
      });

      await completeCheckIssueSnapshot({
        artifactNamespace: artifactNamespace(rootDir),
        rootDir,
        run: {
          blockedBy: { id: 'graph', label: 'graph:check' },
          command: 'limina check',
          completedAt: '2026-06-20T00:00:02.000Z',
          createdAt: '2026-06-20T00:00:00.000Z',
          durationMs: 2000,
          result: 'blocked',
          startedAt: '2026-06-20T00:00:00.000Z',
          tasks: [
            {
              completedAt: '2026-06-20T00:00:01.000Z',
              durationMs: 1000,
              generation: 0,
              id: 'graph',
              issueTask: 'graph:check',
              kind: 'task',
              label: 'graph:check',
              startedAt: '2026-06-20T00:00:00.000Z',
              state: 'failed',
            },
            {
              generation: 0,
              id: 'proof',
              issueTask: 'proof:check',
              kind: 'task',
              label: 'proof:check',
              reason: 'skipped after "graph:check" failed',
              state: 'skipped',
            },
          ],
        },
      });
      await appendCheckIssues({
        artifactNamespace: artifactNamespace(rootDir),
        issues: [secondIssue],
        rootDir,
      });

      expect(await readCheckIssueSnapshot(rootDir)).toMatchObject({
        issues: [
          {
            code: 'LIMINA_GRAPH_REFERENCE_MISSING',
          },
          {
            code: 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE',
          },
        ],
        run: {
          result: 'blocked',
          tasks: [
            {
              label: 'graph:check',
              state: 'failed',
            },
            {
              label: 'proof:check',
              state: 'skipped',
            },
          ],
        },
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('formats the default run summary across tasks', () => {
    const output = formatCheckIssueSnapshotInventory({
      snapshot: createCheckSnapshot([
        {
          code: 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE',
          filePath: 'packages/app/src/internal.ts',
          reason: 'not covered',
          scope: 'packages/app/src',
          task: 'proof:check',
          title: 'Uncovered source file',
        },
        {
          checkerName: 'typescript',
          code: 'LIMINA_CHECKER_BUILD_FAILED',
          filePath: '.limina/checkers/typescript/tsconfig.json',
          reason: 'build failed',
          task: 'checker:build',
          title: 'Checker build failed',
        },
        {
          code: 'LIMINA_PACKAGE_CHECK_FAILED',
          detailLines: ['[publint] package export is invalid'],
          packageManifestPath: 'packages/app/dist/package.json',
          packageName: '@example/app',
          reason: 'package failed',
          task: 'package:check',
          title: 'Package check failed',
          tool: 'publint',
        },
        {
          code: 'LIMINA_PACKAGE_CHECK_FAILED',
          packageName: '@example/app',
          reason: 'package failed',
          task: 'package:check',
          title: 'Package check failed',
          tool: 'attw',
        },
      ]),
    });

    expect(output).toContain('Limina check issue summary');
    expect(output).toContain('Status: completed');
    expect(output).toContain('Matched: 4 / 4 issues');
    expect(output).toContain('Issue overview:');
    expect(output).toContain('Tasks: package:check (2)');
    expect(output).toContain('Packages: @example/app (2)');
    expect(output).toContain('Top rules:');
    expect(output).toContain('2  LIMINA_PACKAGE_CHECK_FAILED');
    expect(output).toContain('Next commands:');
    expect(output).toContain(
      'limina check --issues --rule LIMINA_PACKAGE_CHECK_FAILED --verbose',
    );
  });

  it('formats empty and filtered unified snapshots', () => {
    expect(formatCheckIssueSnapshotInventory({ snapshot: null })).toContain(
      'No check issue snapshot found.',
    );
    expect(
      formatCheckIssueSnapshotInventory({
        snapshot: {
          ...createCheckSnapshot([]),
          status: 'not-run',
        },
      }),
    ).toContain('No completed check issue snapshot is available');

    const emptyOutput = formatCheckIssueSnapshotInventory({
      snapshot: createCheckSnapshot([]),
    });

    expect(emptyOutput).toContain('Limina check issue summary');
    expect(emptyOutput).toContain('Matched: 0 / 0 issues');
    expect(emptyOutput).toContain('Tasks: (none)');
    expect(emptyOutput).toContain('Packages: (none)');
    expect(emptyOutput).toContain('Top rules:');
    expect(emptyOutput).toContain('(none)');

    const filteredOutput = formatCheckIssueSnapshotInventory({
      filters: {
        tasks: ['proof:check'],
      },
      snapshot: createCheckSnapshot([
        {
          code: 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE',
          filePath: 'packages/app/src/internal.ts',
          reason: 'not covered',
          task: 'proof:check',
          title: 'Uncovered source file',
        },
        {
          code: 'LIMINA_PACKAGE_CHECK_FAILED',
          packageName: '@example/app',
          reason: 'package failed',
          task: 'package:check',
          title: 'Package check failed',
          tool: 'publint',
        },
      ]),
    });

    expect(filteredOutput).toContain('Limina check issue summary');
    expect(filteredOutput).toContain('Filters:');
    expect(filteredOutput).toContain('task: proof:check');
    expect(filteredOutput).toContain('Matched: 1 / 2 issues');
    expect(filteredOutput).toContain('Tasks: proof:check (1)');
    expect(filteredOutput).not.toContain('package:check');
  });

  it('filters internal preparation failures by graph:materialize issue task', () => {
    const output = formatCheckIssueSnapshotInventory({
      filters: { tasks: ['graph:materialize'] },
      snapshot: createCheckSnapshot([
        createLiminaCheckIssue({
          code: 'LIMINA_GRAPH_MATERIALIZE_FAILED',
          reason: 'generated artifacts could not be written',
          rootDir: '/repo',
          task: 'graph:materialize',
          title: 'Graph materialization failed',
        }),
        createLiminaCheckIssue({
          code: 'LIMINA_GRAPH_PREPARE_FAILED',
          reason: 'explicit graph prepare failed',
          rootDir: '/repo',
          task: 'graph:prepare',
          title: 'Graph prepare failed',
        }),
      ]),
    });

    expect(output).toContain('task: graph:materialize');
    expect(output).toContain('Matched: 1 / 2 issues');
    expect(output).toContain('LIMINA_GRAPH_MATERIALIZE_FAILED');
    expect(output).not.toContain('LIMINA_GRAPH_PREPARE_FAILED');
  });

  it('formats detailed, json, and ndjson issue inventory output', () => {
    const issue = createLiminaCheckIssue({
      code: 'LIMINA_PACKAGE_PUBLINT',
      evidence: [{ label: 'publint', value: 'export is invalid' }],
      external: {
        code: 'EXPORT_MISSING',
        message: 'export is invalid',
        tool: 'publint',
      },
      filePath: 'packages/app/dist/index.js',
      fixSteps: ['Fix package exports.', 'Rebuild package output.'],
      packageManifestPath: 'packages/app/dist/package.json',
      packageName: '@example/app',
      reason: 'publint reported an invalid export.',
      rootDir: '/repo',
      summary: 'Package export is invalid.',
      task: 'package:check',
      title: 'Publint package issue',
      tool: 'publint',
      verifyCommands: ['limina package check'],
    });
    const snapshot = createCheckSnapshot([issue]);
    const details = formatCheckIssueSnapshotInventory({
      snapshot,
      verbose: true,
    });
    const json = JSON.parse(
      formatCheckIssueSnapshotInventory({
        format: 'json',
        snapshot,
      }),
    ) as {
      issueCount: number;
      issues: CheckIssueSnapshot['issues'];
      overview: { issueCount: number };
      run?: CheckIssueSnapshot['run'];
      topBlockers: { code: string }[];
    };
    const ndjson = formatCheckIssueSnapshotInventory({
      format: 'ndjson',
      snapshot,
    });
    const plainDetails = stripAnsi(details);

    expect(plainDetails).toContain('Package export is invalid.');
    expect(plainDetails).toContain('external:');
    expect(plainDetails).toContain('code: EXPORT_MISSING');
    expect(plainDetails).toContain('fix steps:');
    expect(plainDetails).toContain('verify:');
    expect(plainDetails).toContain('Fix package exports.');
    expect(plainDetails).toContain('limina package check');
    expect(json.issueCount).toBe(1);
    expect(json.overview.issueCount).toBe(1);
    expect(json.issues[0]?.id).toBe(issue.id);
    expect(json.topBlockers[0]?.code).toBe('LIMINA_PACKAGE_PUBLINT');
    expect(JSON.parse(ndjson)).toMatchObject({
      code: 'LIMINA_PACKAGE_PUBLINT',
      id: issue.id,
    });
  });

  it('filters unified inventory by rule, file, scope, package, task, and checker', () => {
    const snapshot = createCheckSnapshot([
      createLiminaCheckIssue({
        checkerName: 'typescript',
        code: 'LIMINA_CHECKER_BUILD_FAILED',
        filePath: '/repo/.limina/checkers/typescript/tsconfig.json',
        packageName: '@example/app',
        reason: 'build failed',
        rootDir: '/repo',
        task: 'checker:build',
        title: 'Checker build failed',
        tool: 'tsgo',
      }),
      createLiminaCheckIssue({
        code: 'LIMINA_PACKAGE_PUBLINT',
        filePath: '/repo/packages/lib/dist/index.js',
        packageName: '@example/lib',
        reason: 'publint failed',
        rootDir: '/repo',
        task: 'package:check',
        title: 'Publint package issue',
        tool: 'publint',
      }),
    ]);
    const output = formatCheckIssueSnapshotInventory({
      filters: {
        checkerNames: ['typescript'],
        files: ['.limina/checkers/typescript/tsconfig.json'],
        packageNames: ['@example/app'],
        rules: ['LIMINA_CHECKER_BUILD_FAILED'],
        scopes: ['.limina/checkers'],
        tasks: ['checker:build'],
      },
      rootDir: '/repo',
      snapshot,
    });

    expect(output).toContain('Limina check issue summary');
    expect(output).toContain('Filters:');
    expect(output).toContain('task: checker:build');
    expect(output).toContain('Matched: 1 / 2 issues');
    expect(output).toContain('Tasks: checker:build (1)');
    expect(output).toContain('1  LIMINA_CHECKER_BUILD_FAILED');
    expect(output).not.toContain('@example/lib');
  });

  it('reports unmatched human filter values with help commands', () => {
    const snapshot = createCheckSnapshot([
      createLiminaCheckIssue({
        checkerName: 'typescript',
        code: 'LIMINA_CHECKER_BUILD_FAILED',
        filePath: '/repo/.limina/checkers/typescript/tsconfig.json',
        packageName: '@example/app',
        reason: 'build failed',
        rootDir: '/repo',
        task: 'checker:build',
        title: 'Checker build failed',
      }),
    ]);
    const output = stripAnsi(
      formatCheckIssueSnapshotInventory({
        filters: {
          checkerNames: ['vue'],
          packageNames: ['@example/missing'],
          rules: ['LIMINA_GRAPH_CHECK_FAILED'],
          tasks: ['proof:check'],
        },
        rootDir: '/repo',
        snapshot,
      }),
    );
    const normalizedOutput = output
      .replaceAll(/\s*│\s*/gu, ' ')
      .replaceAll(/\s+/gu, ' ');

    expect(output).toContain('Matched: 0 / 1 issues');
    expect(output).toContain('Filter diagnostics:');
    expect(output).toContain(
      'task "proof:check" has no issues in the last snapshot.',
    );
    expect(normalizedOutput).toContain('limina check --issues --task --help');
    expect(output).toContain(
      'package "@example/missing" has no issues in the last snapshot.',
    );
    expect(normalizedOutput).toContain(
      'limina check --issues --package --help',
    );
    expect(output).toContain(
      'Supported rule "LIMINA_GRAPH_CHECK_FAILED" is absent from the last snapshot.',
    );
    expect(normalizedOutput).toContain('limina check --issues --rule --help');
    expect(output).toContain(
      'checker "vue" has no issues in the last snapshot.',
    );
    expect(normalizedOutput).toContain(
      'limina check --issues --checker --help',
    );
  });
});
function artifactNamespace(rootDir: string) {
  return createLiminaArtifactNamespace({ generation: 0, rootDir });
}
