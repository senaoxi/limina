import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'pathe';
import { describe, expect, it } from 'vitest';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import {
  type CheckIssueInventoryView,
  DEFAULT_PRIMARY_BLOCKER_LIMIT,
  DEFAULT_VISIBLE_ISSUE_LIMIT,
} from '../check-reporting/inventory-presentation';
import {
  appendCheckIssues,
  CHECK_ISSUE_SNAPSHOT_VERSION,
  type CheckIssueInventoryFilters,
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
  readSourceIssueSnapshot,
  SOURCE_ISSUE_SNAPSHOT_VERSION,
  type SourceIssueSnapshot,
  writeSourceIssueSnapshotOnly,
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

function formatHumanInventory(options: {
  color?: boolean;
  filters?: CheckIssueInventoryFilters;
  limit?: number | null;
  limitExplicit?: boolean;
  rootDir?: string;
  snapshot: CheckIssueSnapshot | null;
  verbose?: boolean;
  view?: CheckIssueInventoryView;
}): string {
  const filters = options.filters ?? {};
  const limit =
    options.limit === undefined ? DEFAULT_VISIBLE_ISSUE_LIMIT : options.limit;
  const verbose = options.verbose ?? false;
  const hasFilters = Object.values(filters).some((values) => values?.length);

  return formatCheckIssueSnapshotInventory({
    color: options.color ?? true,
    format: 'human',
    presentation: {
      maxIssues: limit,
      maxPrimaryBlockers: DEFAULT_PRIMARY_BLOCKER_LIMIT,
      view:
        options.view ??
        (verbose ? 'detailed' : hasFilters ? 'compact' : 'summary'),
    },
    queryContext: {
      effectiveFormat: 'human',
      filters,
      global: {},
      limit,
      limitExplicit: options.limitExplicit ?? false,
      verbose,
    },
    ...(options.rootDir ? { rootDir: options.rootDir } : {}),
    snapshot: options.snapshot,
  });
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
  it('keeps version 1 readable without promoting it to a check snapshot', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));

    try {
      await writeSourceIssueSnapshotOnly(
        artifactNamespace(rootDir),
        createSnapshot([
          {
            code: SOURCE_ISSUE_CODES.unusedModule,
            filePath: 'packages/app/src/unused.ts',
            ownerName: '@example/app',
          },
        ]),
      );

      await expect(readSourceIssueSnapshot(rootDir)).resolves.toMatchObject({
        issues: [
          {
            code: SOURCE_ISSUE_CODES.unusedModule,
            ownerName: '@example/app',
          },
        ],
        version: SOURCE_ISSUE_SNAPSHOT_VERSION,
      });
      await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();
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
  it('writes and reads canonical codes while preserving external rule codes', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));
    const issue = createLiminaCheckIssue({
      code: LIMINA_CHECK_ISSUE_CODES.packagePublint,
      external: {
        code: 'EXPORT_MISSING',
        message: 'Package export is missing.',
        tool: 'publint',
      },
      reason: 'Publint reported a package export problem.',
      rootDir,
      task: 'package:check',
      title: 'Publint package issue',
    });

    try {
      await writeCheckIssueSnapshotOnly(
        artifactNamespace(rootDir),
        createCheckSnapshot([issue]),
      );

      await expect(readCheckIssueSnapshot(rootDir)).resolves.toMatchObject({
        issues: [
          {
            code: 'LIMINA_PACKAGE_PUBLINT',
            external: { code: 'EXPORT_MISSING', tool: 'publint' },
            task: 'package:check',
          },
        ],
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('keeps the explicitly retired command wire code readable', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));
    const issue = createLiminaCheckIssue({
      code: LIMINA_CHECK_ISSUE_CODES.commandFailed,
      rootDir,
      task: 'command',
    });

    try {
      await writeRawCheckSnapshot(
        rootDir,
        createCheckSnapshot([
          {
            ...issue,
            code: LIMINA_CHECK_ISSUE_CODES.pipelineCommandFailed,
          },
        ]),
      );

      await expect(readCheckIssueSnapshot(rootDir)).resolves.toMatchObject({
        issues: [
          {
            code: LIMINA_CHECK_ISSUE_CODES.pipelineCommandFailed,
            task: 'command',
          },
        ],
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it.each([
    ['unknown', 'LIMINA_HISTORICAL_EXTENSION_CODE', 'source:check'],
    ['planned', LIMINA_CHECK_ISSUE_CODES.releaseConsistency, 'release:check'],
    [
      'task-mismatched',
      LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap,
      'source:check',
    ],
  ] as const)(
    'rejects %s codes from the current reader',
    async (_name, code, task) => {
      const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));
      const issue = createLiminaCheckIssue({
        code: LIMINA_CHECK_ISSUE_CODES.sourceCheckFailed,
        rootDir,
        task: 'source:check',
      });

      try {
        await writeRawCheckSnapshot(rootDir, {
          ...createCheckSnapshot([issue]),
          issues: [{ ...issue, code, task }],
        });

        await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();
      } finally {
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );

  it.each([
    ['unknown', 'LIMINA_NOT_REGISTERED', 'source:check'],
    ['planned', LIMINA_CHECK_ISSUE_CODES.releaseConsistency, 'release:check'],
    ['retired', LIMINA_CHECK_ISSUE_CODES.pipelineCommandFailed, 'command'],
    [
      'task-mismatched',
      LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap,
      'source:check',
    ],
  ] as const)(
    'rejects %s codes from the current writer',
    async (_name, code, task) => {
      const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));
      const canonicalIssue = createLiminaCheckIssue({
        code: LIMINA_CHECK_ISSUE_CODES.sourceCheckFailed,
        rootDir,
        task: 'source:check',
      });

      try {
        const invalidSnapshot = {
          ...createCheckSnapshot([canonicalIssue]),
          issues: [{ ...canonicalIssue, code, task }],
        } as unknown as CheckIssueSnapshot;

        await expect(
          writeCheckIssueSnapshotOnly(
            artifactNamespace(rootDir),
            invalidSnapshot,
          ),
        ).rejects.toThrow();
        await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();
      } finally {
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );

  it.each([1, 2, 3, 4, 5, 6])(
    'returns null for check snapshot version %i',
    async (version) => {
      const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));

      try {
        await writeRawCheckSnapshot(rootDir, {
          ...createCheckSnapshot([]),
          version,
        });

        await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();
      } finally {
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );

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
  ] as const)('rejects current v7 completed when %s', async (_name, mutate) => {
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

  it('accepts check-owned snapshots and rejects standalone completed snapshots', async () => {
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

      await writeRawCheckSnapshot(rootDir, {
        ...createCheckSnapshot([]),
        command: 'limina source check',
      });
      await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();

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

  it('returns null for missing and corrupt check snapshots', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-snapshot-'));

    try {
      await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();

      const snapshotPath = getCheckIssueSnapshotPath(rootDir);
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(snapshotPath, '{not valid json\n');
      await expect(readCheckIssueSnapshot(rootDir)).resolves.toBeNull();
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
    const output = formatHumanInventory({
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
    const plainOutput = stripAnsi(output);

    expect(plainOutput).toContain('Limina check issue summary');
    expect(plainOutput).toContain('Status: completed');
    expect(plainOutput).toContain('Matched: 4 / 4 issues');
    expect(plainOutput).toContain('Issue overview:');
    expect(plainOutput).toContain('Tasks: package:check (2)');
    expect(plainOutput).toContain('Packages: @example/app (2)');
    expect(plainOutput).toContain('Top rules:');
    expect(plainOutput).toContain('2  LIMINA_PACKAGE_CHECK_FAILED');
    expect(plainOutput).toContain('Next commands:');
    expect(plainOutput).toContain('limina check --issues --limit 20');
    expect(plainOutput).toContain('limina check --issues --task package:check');
    expect(plainOutput).toContain('LIMINA_PACKAGE_CHECK_FAILED');
  });

  it('formats empty and filtered unified snapshots', () => {
    expect(formatHumanInventory({ snapshot: null })).toContain(
      'No check issue snapshot found.',
    );
    expect(
      formatHumanInventory({
        snapshot: {
          ...createCheckSnapshot([]),
          status: 'not-run',
        },
      }),
    ).toContain('No completed check issue snapshot is available');

    const emptyOutput = formatHumanInventory({
      snapshot: createCheckSnapshot([]),
    });
    const plainEmptyOutput = stripAnsi(emptyOutput);

    expect(plainEmptyOutput).toContain('Limina check issue summary');
    expect(plainEmptyOutput).toContain('Matched: 0 / 0 issues');
    expect(plainEmptyOutput).toContain('Tasks: (none)');
    expect(plainEmptyOutput).toContain('Packages: (none)');
    expect(plainEmptyOutput).toContain('Top rules:');
    expect(plainEmptyOutput).toContain('(none)');

    const filteredOutput = formatHumanInventory({
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
    const plainFilteredOutput = stripAnsi(filteredOutput);

    expect(plainFilteredOutput).toContain('Limina check issue summary');
    expect(plainFilteredOutput).toContain('Filters:');
    expect(plainFilteredOutput).toContain('task: proof:check');
    expect(plainFilteredOutput).toContain('Matched: 1 / 2 issues');
    expect(plainFilteredOutput).toContain('Tasks: proof:check (1)');
    expect(plainFilteredOutput).not.toContain('package:check');
  });

  it('colors issue inventory summary titles like live check summaries', () => {
    const passedOutput = formatHumanInventory({
      snapshot: {
        ...createCheckSnapshot([]),
        run: createCompletedRun(),
      },
    });
    const failedOutput = formatHumanInventory({
      snapshot: {
        ...createCheckSnapshot([
          {
            code: 'LIMINA_SOURCE_UNCOVERED_FILE',
            reason: 'source file is not covered',
            task: 'source:check',
            title: 'Uncovered source file',
          },
        ]),
        run: createCompletedRun([], 'failed'),
      },
    });

    expect(passedOutput).toContain(
      `${ANSI_ESCAPE}[32m╭ Limina check issue summary`,
    );
    expect(failedOutput).toContain(
      `${ANSI_ESCAPE}[31m╭ Limina check issue summary`,
    );
    expect(failedOutput).toContain(
      `${ANSI_ESCAPE}[35mIssue overview:${ANSI_ESCAPE}[0m`,
    );
    expect(failedOutput).toContain(
      `${ANSI_ESCAPE}[34mTop rules:${ANSI_ESCAPE}[0m`,
    );
    expect(failedOutput).toContain(
      `${ANSI_ESCAPE}[36mPrimary blockers:${ANSI_ESCAPE}[0m`,
    );
    expect(failedOutput).toContain(
      `${ANSI_ESCAPE}[36mNext commands:${ANSI_ESCAPE}[0m`,
    );
  });

  it('omits ANSI from detailed issue inventory output when color is disabled', () => {
    const output = formatHumanInventory({
      color: false,
      snapshot: {
        ...createCheckSnapshot([
          {
            code: 'LIMINA_SOURCE_UNCOVERED_FILE',
            reason: 'source file is not covered',
            task: 'source:check',
            title: 'Uncovered source file',
          },
        ]),
        run: createCompletedRun([], 'failed'),
      },
      view: 'detailed',
    });

    expect(output).not.toMatch(ANSI_PATTERN);
    expect(output).toContain('Limina check issue summary');
    expect(output).toContain('Uncovered source file');
  });

  it('filters internal preparation failures by graph:materialize issue task', () => {
    const output = formatHumanInventory({
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
    const plainOutput = stripAnsi(output);

    expect(plainOutput).toContain('task: graph:materialize');
    expect(plainOutput).toContain('Matched: 1 / 2 issues');
    expect(plainOutput).toContain('LIMINA_GRAPH_MATERIALIZE_FAILED');
    expect(plainOutput).not.toContain('LIMINA_GRAPH_PREPARE_FAILED');
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
    const details = formatHumanInventory({
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

  it('preserves resource module source codes in JSON and NDJSON inventories', () => {
    const issues = [
      createLiminaCheckIssue({
        checkerName: 'typescript',
        code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleNotFound,
        filePath: 'packages/app/src/index.ts',
        reason: 'The physical resource is missing.',
        rootDir: '/repo',
        task: 'source:check',
        title: 'Resource module was not found',
      }),
      createLiminaCheckIssue({
        checkerName: 'vue',
        code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleTypeUndeclared,
        filePath: 'packages/web/src/App.vue',
        reason: 'The current Vue checker project has no declaration.',
        rootDir: '/repo',
        task: 'source:check',
        title: 'Resource module type is undeclared',
      }),
    ];
    const snapshot = createCheckSnapshot(issues);
    const json = JSON.parse(
      formatCheckIssueSnapshotInventory({ format: 'json', snapshot }),
    ) as { issues: CheckIssueSnapshot['issues'] };
    const ndjson = formatCheckIssueSnapshotInventory({
      format: 'ndjson',
      snapshot,
    })
      .split('\n')
      .map((line) => JSON.parse(line) as CheckIssueSnapshot['issues'][number]);

    expect(json.issues.map((issue) => issue.code)).toEqual(
      issues.map((issue) => issue.code),
    );
    expect(ndjson).toEqual([
      expect.objectContaining({
        checkerName: 'typescript',
        code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleNotFound,
        task: 'source:check',
      }),
      expect.objectContaining({
        checkerName: 'vue',
        code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleTypeUndeclared,
        task: 'source:check',
      }),
    ]);
  });

  it('preserves the frozen machine inventory payload and issue order', () => {
    const issues: CheckIssueSnapshot['issues'] = [
      {
        code: 'RULE_B',
        filePath: 'packages/b/src/b.ts',
        packageName: '@example/b',
        reason: 'Rule B failed.',
        severity: 'warning',
        task: 'proof:check',
        title: 'Rule B',
      },
      {
        code: 'RULE_A',
        filePath: 'packages/a/src/a.ts',
        packageName: '@example/a',
        reason: 'Rule A failed.',
        task: 'source:check',
        title: 'Rule A',
      },
      {
        code: 'RULE_A',
        filePath: 'packages/b/src/a.ts',
        packageName: '@example/b',
        reason: 'Rule A failed.',
        task: 'source:check',
        title: 'Rule A',
      },
    ];
    const run = createCompletedRun([], 'failed');
    const snapshot: CheckIssueSnapshot = {
      command: 'limina check',
      createdAt: '2026-07-17T00:00:00.000Z',
      issues,
      run,
      status: 'completed',
      version: CHECK_ISSUE_SNAPSHOT_VERSION,
    };

    expect(
      JSON.parse(
        formatCheckIssueSnapshotInventory({ format: 'json', snapshot }),
      ),
    ).toEqual({
      command: 'limina check',
      createdAt: '2026-07-17T00:00:00.000Z',
      filters: {},
      issueCount: 3,
      issues,
      overview: {
        affectedFiles: 3,
        affectedPackages: 2,
        affectedScopes: 2,
        checkers: [],
        issueCount: 3,
        packages: [
          { count: 2, name: '@example/b' },
          { count: 1, name: '@example/a' },
        ],
        rules: [
          { count: 2, name: 'RULE_A' },
          { count: 1, name: 'RULE_B' },
        ],
        scopes: [
          { count: 2, name: 'packages/b/src' },
          { count: 1, name: 'packages/a/src' },
        ],
        severities: [
          { count: 2, name: 'error' },
          { count: 1, name: 'warning' },
        ],
        tasks: [
          { count: 2, name: 'source:check' },
          { count: 1, name: 'proof:check' },
        ],
      },
      run,
      status: 'completed',
      topBlockers: [
        {
          affectedFiles: 2,
          affectedPackages: 2,
          code: 'RULE_A',
          count: 2,
          packages: [
            { count: 1, name: '@example/a' },
            { count: 1, name: '@example/b' },
          ],
          summary: 'Rule A failed.',
          task: 'source:check',
          title: 'Rule A',
        },
        {
          affectedFiles: 1,
          affectedPackages: 1,
          code: 'RULE_B',
          count: 1,
          packages: [{ count: 1, name: '@example/b' }],
          severity: 'warning',
          summary: 'Rule B failed.',
          task: 'proof:check',
          title: 'Rule B',
        },
      ],
      version: CHECK_ISSUE_SNAPSHOT_VERSION,
    });
    expect(
      formatCheckIssueSnapshotInventory({ format: 'ndjson', snapshot })
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual(issues);
  });

  it('does not mutate snapshots or issue ids across human inventory views', () => {
    const snapshot = createCheckSnapshot([
      createLiminaCheckIssue({
        code: LIMINA_CHECK_ISSUE_CODES.sourceCheckFailed,
        evidence: [{ label: 'details', lines: ['one', 'two'] }],
        filePath: '/repo/packages/app/src/index.ts',
        packageName: '@example/app',
        reason: 'Root A failed.',
        rootDir: '/repo',
        task: 'source:check',
        title: 'Root A',
      }),
      createLiminaCheckIssue({
        code: LIMINA_CHECK_ISSUE_CODES.proofCheckFailed,
        filePath: '/repo/packages/lib/src/index.ts',
        packageName: '@example/lib',
        reason: 'Root B failed.',
        rootDir: '/repo',
        task: 'proof:check',
        title: 'Root B',
      }),
    ]);
    const before = JSON.stringify(snapshot);
    const ids = snapshot.issues.map((issue) => issue.id);

    formatHumanInventory({ snapshot, view: 'summary' });
    formatHumanInventory({ snapshot, view: 'compact' });
    formatHumanInventory({ snapshot, verbose: true, view: 'detailed' });
    formatHumanInventory({ limit: null, snapshot, view: 'compact' });

    expect(JSON.stringify(snapshot)).toBe(before);
    expect(snapshot.issues.map((issue) => issue.id)).toEqual(ids);
  });

  it('keeps invocation identity in every generated query command', () => {
    const invocationId = '00000000-0000-4000-8000-000000000000';
    const issue = createLiminaCheckIssue({
      code: LIMINA_CHECK_ISSUE_CODES.sourceCheckFailed,
      filePath: '/repo/packages/app/src/index.ts',
      reason: 'Root A failed.',
      rootDir: '/repo',
      task: 'source:check',
      title: 'Root A',
    });
    const output = stripAnsi(
      formatCheckIssueSnapshotInventory({
        color: false,
        format: 'human',
        invocation: {
          completedAt: '2026-07-17T00:00:01.000Z',
          invocationId,
          kind: 'standalone-invocation',
          result: 'failed',
          version: 1,
        },
        presentation: {
          maxIssues: 20,
          maxPrimaryBlockers: DEFAULT_PRIMARY_BLOCKER_LIMIT,
          view: 'compact',
        },
        queryContext: {
          effectiveFormat: 'human',
          filters: {},
          global: {},
          invocationId,
          limit: 20,
          limitExplicit: false,
          verbose: false,
        },
        snapshot: {
          ...createCheckSnapshot([issue]),
          command: 'recorded command --must-not-be-used-for-query-building',
        },
      }),
    );
    const normalized = output
      .replaceAll(/\s*│\s*/gu, ' ')
      .replaceAll(/\s+/gu, ' ');

    expect(output).toContain(`Invocation: ${invocationId}`);
    expect(output).toContain('Kind: standalone-invocation');
    expect(output).toContain('Result: failed');
    expect(output).toContain('Completed: 2026-07-17T00:00:01.000Z');
    expect(normalized).toContain(
      `limina check --issues --invocation ${invocationId}`,
    );
    expect(normalized).not.toContain(
      'recorded command --must-not-be-used-for-query-building --',
    );
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
    const output = formatHumanInventory({
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
    const plainOutput = stripAnsi(output);

    expect(plainOutput).toContain('Limina check issue summary');
    expect(plainOutput).toContain('Filters:');
    expect(plainOutput).toContain('task: checker:build');
    expect(plainOutput).toContain('Matched: 1 / 2 issues');
    expect(plainOutput).toContain('Tasks: checker:build (1)');
    expect(plainOutput).toContain('1  LIMINA_CHECKER_BUILD_FAILED');
    expect(plainOutput).not.toContain('@example/lib');
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
      formatHumanInventory({
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
    expect(output).not.toContain('Showing 0');
    expect(output).toContain('Filter diagnostics:');
    expect(output).toContain(
      'task "proof:check" has no issues in the last snapshot.',
    );
    expect(normalizedOutput).toContain('--task --help');
    expect(output).toContain(
      'package "@example/missing" has no issues in the last snapshot.',
    );
    expect(normalizedOutput).toContain('--package --help');
    expect(output).toContain(
      'Supported rule "LIMINA_GRAPH_CHECK_FAILED" is absent from the last snapshot.',
    );
    expect(normalizedOutput).toContain('--rule --help');
    expect(output).toContain(
      'checker "vue" has no issues in the last snapshot.',
    );
    expect(normalizedOutput).toContain('--checker --help');
  });
});
function artifactNamespace(rootDir: string) {
  return createLiminaArtifactNamespace({ generation: 0, rootDir });
}
