import { describe, expect, it } from 'vitest';
import { formatCheckIssueInventoryCard } from '../check-reporting/human';
import type { InventoryQueryContext } from '../check-reporting/inventory-presentation';
import {
  compareCanonicalIssues,
  createCanonicalIssueFingerprint,
  DEFAULT_PRIMARY_BLOCKER_LIMIT,
  formatInventoryQueryCommand,
  getCanonicalIssueLocation,
  selectHumanPrimaryBlockers,
  selectInventoryIssues,
} from '../check-reporting/inventory-presentation';
import {
  CHECK_ISSUE_SNAPSHOT_VERSION,
  formatCheckIssueSnapshotInventory,
  type LiminaCheckIssue,
  type LiminaCheckTaskName,
} from '../check-reporting/snapshot';
import { createLiminaCheckIssue } from '../check-reporting/structured';

const ANSI_ESCAPE = String.fromCodePoint(0x1b);
const ANSI_PATTERN = new RegExp(
  String.raw`${ANSI_ESCAPE}\[[\d:;<=>?]*[\u0020-\u002F]*[\u0040-\u007E]`,
  'gu',
);

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_PATTERN, '');
}

function createIssue(options: {
  checkerName?: string;
  code: string;
  filePath?: string;
  packageName?: string;
  task?: LiminaCheckTaskName;
  title: string;
  tool?: string;
}): LiminaCheckIssue {
  return createLiminaCheckIssue({
    checkerName: options.checkerName,
    code: options.code,
    filePath: options.filePath,
    packageName: options.packageName,
    reason: `${options.title} failed.`,
    rootDir: '/repo',
    task: options.task ?? 'source:check',
    title: options.title,
    tool: options.tool,
  });
}

function createQueryContext(
  overrides: Partial<InventoryQueryContext> = {},
): InventoryQueryContext {
  return {
    effectiveFormat: 'human',
    filters: {},
    global: {},
    limit: 20,
    limitExplicit: false,
    verbose: false,
    ...overrides,
  };
}

function getPermutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) {
    return [[...values]];
  }

  return values.flatMap((value, index) =>
    getPermutations(values.filter((_, itemIndex) => itemIndex !== index)).map(
      (remaining) => [value, ...remaining],
    ),
  );
}

describe('check issue inventory presentation', () => {
  it('selects exactly twenty canonical issues from one root and package', () => {
    const issues = Array.from({ length: 96 }, (_, index) =>
      createIssue({
        code: 'ROOT_A',
        filePath: `/repo/packages/app/src/file-${String(index).padStart(3, '0')}.ts`,
        packageName: '@example/app',
        title: 'Root A',
      }),
    ).toReversed();
    const selected = selectInventoryIssues(issues, 20);

    expect(selected).toHaveLength(20);
    expect(selected.map((issue) => issue.filePath)).toEqual(
      Array.from(
        { length: 20 },
        (_, index) =>
          `packages/app/src/file-${String(index).padStart(3, '0')}.ts`,
      ),
    );
  });

  it('gives unrelated root causes first-round visibility across 100 packages', () => {
    const highFrequencyRoot = Array.from({ length: 100 }, (_, index) =>
      createIssue({
        code: 'ROOT_A',
        filePath: `/repo/packages/pkg-${String(index).padStart(3, '0')}/src/index.ts`,
        packageName: `@example/pkg-${String(index).padStart(3, '0')}`,
        title: 'Root A',
      }),
    );
    const issues = [
      ...highFrequencyRoot,
      createIssue({
        code: 'ROOT_B',
        filePath: '/repo/packages/blocker-b/src/index.ts',
        packageName: '@example/blocker-b',
        title: 'Root B',
      }),
      createIssue({
        code: 'ROOT_C',
        filePath: '/repo/packages/blocker-c/src/index.ts',
        packageName: '@example/blocker-c',
        title: 'Root C',
      }),
    ].toReversed();
    const selected = selectInventoryIssues(issues, 20);

    expect(selected.slice(0, 3).map((issue) => issue.code)).toEqual([
      'ROOT_A',
      'ROOT_B',
      'ROOT_C',
    ]);
    expect(new Set(selected.map((issue) => issue.code))).toEqual(
      new Set(['ROOT_A', 'ROOT_B', 'ROOT_C']),
    );
  });

  it('round-robins package sub-buckets within one root cause', () => {
    const issues = [
      createIssue({
        code: 'ROOT_A',
        filePath: '/repo/packages/a/src/2.ts',
        packageName: '@example/a',
        title: 'Root A',
      }),
      createIssue({
        code: 'ROOT_A',
        filePath: '/repo/packages/b/src/2.ts',
        packageName: '@example/b',
        title: 'Root A',
      }),
      createIssue({
        code: 'ROOT_A',
        filePath: '/repo/packages/c/src/1.ts',
        packageName: '@example/c',
        title: 'Root A',
      }),
      createIssue({
        code: 'ROOT_A',
        filePath: '/repo/packages/a/src/1.ts',
        packageName: '@example/a',
        title: 'Root A',
      }),
      createIssue({
        code: 'ROOT_A',
        filePath: '/repo/packages/b/src/1.ts',
        packageName: '@example/b',
        title: 'Root A',
      }),
    ];

    expect(
      selectInventoryIssues(issues, 5).map((issue) => issue.filePath),
    ).toEqual([
      'packages/a/src/1.ts',
      'packages/b/src/1.ts',
      'packages/c/src/1.ts',
      'packages/a/src/2.ts',
      'packages/b/src/2.ts',
    ]);
  });

  it('produces identical selection, blockers, and ANSI output for every permutation', () => {
    const issues = [
      createIssue({
        code: 'ROOT_A',
        filePath: '/repo/packages/a/src/a.ts',
        packageName: '@example/a',
        title: 'Root A',
      }),
      createIssue({
        code: 'ROOT_A',
        filePath: '/repo/packages/b/src/b.ts',
        packageName: '@example/b',
        title: 'Root A',
      }),
      createIssue({
        code: 'ROOT_B',
        filePath: '/repo/packages/a/src/c.ts',
        packageName: '@example/a',
        title: 'Root B',
      }),
      createIssue({
        code: 'ROOT_C',
        filePath: '/repo/packages/c/src/d.ts',
        packageName: '@example/c',
        title: 'Root C',
      }),
    ];
    const outputs = getPermutations(issues).map((permutation) => ({
      blockers: selectHumanPrimaryBlockers(permutation).map((blocker) => ({
        code: blocker.code,
        count: blocker.count,
        packages: blocker.packages,
      })),
      report: formatCheckIssueSnapshotInventory({
        format: 'human',
        presentation: {
          maxIssues: 3,
          maxPrimaryBlockers: DEFAULT_PRIMARY_BLOCKER_LIMIT,
          view: 'compact',
        },
        queryContext: {
          ...createQueryContext(),
          limit: 3,
          limitExplicit: true,
        },
        snapshot: {
          command: 'limina check',
          createdAt: '2026-07-17T00:00:00.000Z',
          issues: permutation,
          status: 'completed',
          version: CHECK_ISSUE_SNAPSHOT_VERSION,
        },
      }),
      selectedIds: selectInventoryIssues(permutation, 3).map(
        (issue) => issue.id,
      ),
    }));

    expect(new Set(outputs.map((output) => JSON.stringify(output))).size).toBe(
      1,
    );
  });

  it('uses package only for impact and sampling, not blocker identity', () => {
    const issues = Array.from({ length: 100 }, (_, index) =>
      createIssue({
        code: 'ROOT_A',
        filePath: `/repo/packages/p${index}/src/index.ts`,
        packageName: `@example/p${index}`,
        title: 'Root A',
      }),
    );
    const blockers = selectHumanPrimaryBlockers(issues);

    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      affectedPackages: 100,
      code: 'ROOT_A',
      count: 100,
    });
  });

  it('keeps compact cards fixed while detailed cards render all diagnostic arrays', () => {
    const evidenceLines = Array.from(
      { length: 300 },
      (_, index) => `provider candidate ${index}`,
    );
    const base = {
      code: 'LIMINA_GRAPH_PREPARE_FAILED',
      filePath: '/repo/packages/app/src/index.ts',
      fix: 'Choose one provider.\nThen rerun the check.',
      packageName: '@example/app',
      reason: 'Provider candidates are ambiguous.\nInspect the graph.',
      rootDir: '/repo',
      summary: 'Provider selection is ambiguous.\nMultiple candidates remain.',
      task: 'graph:prepare' as const,
      title: 'Ambiguous\nprovider selection',
    };
    const largeIssue = createLiminaCheckIssue({
      ...base,
      detailLines: [evidenceLines[0]!, evidenceLines.at(-1)!, 'raw-only'],
      detector: 'graph-prepare',
      evidence: [{ label: 'candidates', lines: evidenceLines }],
      fixSteps: ['Pick the owner.', 'Regenerate the graph.'],
      locations: [
        { filePath: 'packages/app/src/index.ts', label: 'source' },
        { filePath: 'packages/lib/src/index.ts', label: 'candidate' },
      ],
      verifyCommands: ['limina graph prepare', 'limina check'],
    });
    const smallIssue = createLiminaCheckIssue({
      ...base,
      detector: 'graph-prepare',
      evidence: [],
      locations: [],
    });
    const compactLarge = formatCheckIssueInventoryCard({
      issue: largeIssue,
      representativeLocation: getCanonicalIssueLocation(largeIssue),
      view: 'compact',
    });
    const compactSmall = formatCheckIssueInventoryCard({
      issue: smallIssue,
      representativeLocation: getCanonicalIssueLocation(smallIssue),
      view: 'compact',
    });
    const detailed = stripAnsi(
      formatCheckIssueInventoryCard({
        issue: largeIssue,
        representativeLocation: getCanonicalIssueLocation(largeIssue),
        view: 'detailed',
      }),
    );
    const guardedIssue = {
      ...smallIssue,
      external: { tool: 'graph provider' },
    };

    for (const field of [
      'detailLines',
      'evidence',
      'fixSteps',
      'locations',
      'verifyCommands',
    ] as const) {
      Object.defineProperty(guardedIssue, field, {
        get: () => {
          throw new Error(`compact renderer accessed ${field}`);
        },
      });
    }

    Object.defineProperties(guardedIssue.external, {
      code: {
        get: () => {
          throw new Error('compact renderer accessed external code');
        },
      },
      message: {
        get: () => {
          throw new Error('compact renderer accessed external message');
        },
      },
      url: {
        get: () => {
          throw new Error('compact renderer accessed external url');
        },
      },
    });

    expect(compactLarge).toBe(compactSmall);
    expect(() =>
      formatCheckIssueInventoryCard({
        issue: guardedIssue,
        representativeLocation: 'packages/app/src/index.ts',
        view: 'compact',
      }),
    ).not.toThrow();
    expect(stripAnsi(compactLarge)).not.toContain('provider candidate 0');
    expect(stripAnsi(compactLarge)).not.toContain('fix steps:');
    expect(stripAnsi(compactLarge)).not.toContain('verify:');
    expect(stripAnsi(compactLarge)).not.toContain('candidate:');
    expect(detailed).toContain('provider candidate 0');
    expect(detailed).toContain('provider candidate 299');
    expect(detailed).toContain('candidate: packages/lib/src/index.ts');
    expect(detailed).toContain('Pick the owner.');
    expect(detailed).toContain('limina graph prepare');
    expect(detailed).toContain('raw-only');
    expect(detailed.match(/provider candidate 0/gu)).toHaveLength(1);
    expect(detailed.match(/provider candidate 299/gu)).toHaveLength(1);
  });

  it('orders tied issues with a fixed persisted-field fingerprint without mutation', () => {
    const left = createLiminaCheckIssue({
      code: 'ROOT_A',
      evidence: [{ label: 'provider', lines: ['a'] }],
      reason: 'Root A failed.',
      rootDir: '/repo',
      task: 'source:check',
      title: 'Root A',
    });
    const right = {
      ...left,
      evidence: [{ label: 'provider', lines: ['b'] }],
    };
    const before = JSON.stringify([left, right]);

    expect(compareCanonicalIssues(left, right)).not.toBe(0);
    expect(createCanonicalIssueFingerprint(left)).not.toBe(
      createCanonicalIssueFingerprint(right),
    );
    selectInventoryIssues([right, left], null);
    selectHumanPrimaryBlockers([right, left]);
    expect(JSON.stringify([left, right])).toBe(before);
  });

  it('builds contextual POSIX and PowerShell commands without snapshot command parsing', () => {
    const context = createQueryContext({
      filters: {
        checkerNames: ['vue checker'],
        files: ['packages/app/$HOME.ts'],
        packageNames: ['@example/app', '@example/app'],
        rules: ['ROOT_A'],
        scopes: ['packages/app/**'],
        tasks: ['source:check'],
      },
      global: {
        configLoader: 'tsx',
        configPath: '/repo/config files/limina.config.mts',
        mode: 'test mode',
      },
      invocationId: '00000000-0000-4000-8000-000000000000',
      limit: 7,
      limitExplicit: true,
      verbose: true,
    });
    const posix = formatInventoryQueryCommand(context, {
      additionalFilters: {
        rules: ['ROOT_A', 'ROOT_B'],
        tasks: ['source:check'],
      },
      dialect: 'posix',
      limit: 'all',
      verbose: true,
    });
    const powershell = formatInventoryQueryCommand(context, {
      dialect: 'powershell',
      format: 'json',
    });

    expect(posix).toBe(
      "limina --config '/repo/config files/limina.config.mts' --config-loader tsx --mode 'test mode' check --issues --invocation 00000000-0000-4000-8000-000000000000 --task source:check --rule ROOT_A --rule ROOT_B --package @example/app --file 'packages/app/$HOME.ts' --scope 'packages/app/**' --checker 'vue checker' --verbose --limit all",
    );
    expect(powershell).toContain(
      "--config '/repo/config files/limina.config.mts'",
    );
    expect(powershell).toContain("--file 'packages/app/$HOME.ts'");
    expect(powershell).toContain('--format json');
    expect(powershell).not.toContain('--limit');
    expect(powershell).not.toContain('--verbose');
  });
});
