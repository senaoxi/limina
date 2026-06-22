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
  readCheckIssueSnapshot,
  writeNotRunCheckIssueSnapshot,
} from '../check-reporting/snapshot';
import { createLiminaCheckIssue } from '../check-reporting/structured';
import { SOURCE_ISSUE_CODES } from '../source-check/report';
import {
  formatSourceIssueSnapshotInventory,
  SOURCE_ISSUE_SNAPSHOT_VERSION,
  type SourceIssueSnapshot,
} from '../source-check/snapshot';

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
    legacyProblemCount: 0,
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

describe('source issue snapshots', () => {
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
    expect(
      formatSourceIssueSnapshotInventory({
        ...createSnapshot([]),
        legacyProblemCount: 2,
      }),
    ).toContain('The last source check reported 2 unfilterable issues.');
  });
});

describe('check issue snapshots', () => {
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

  it('reads legacy v1, v2, v3, and current v4 check snapshots', async () => {
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

      expect(await readCheckIssueSnapshot(rootDir)).toMatchObject({
        issues: [
          {
            code: 'LIMINA_PACKAGE_CHECK_FAILED',
            title: 'Package check failed',
          },
        ],
        version: 1,
      });

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

      const versionTwoSnapshot = await readCheckIssueSnapshot(rootDir);

      expect(versionTwoSnapshot).toMatchObject({
        issues: [
          {
            code: 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE',
            id: expect.any(String),
          },
        ],
        version: 2,
      });
      expect(versionTwoSnapshot?.run).toBeUndefined();

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

      expect(await readCheckIssueSnapshot(rootDir)).toMatchObject({
        issues: [
          {
            code: 'LIMINA_GRAPH_REFERENCE_MISSING',
            id: expect.any(String),
          },
        ],
        run: {
          result: 'blocked',
          tasks: [
            {
              name: 'graph:check',
              status: 'failed',
            },
          ],
        },
        version: 3,
      });

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
              name: 'source:check',
              status: 'failed',
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
        command: 'limina check',
        rootDir,
        run: {
          command: 'limina check',
          createdAt: '2026-06-20T00:00:00.000Z',
          result: 'running',
          startedAt: '2026-06-20T00:00:00.000Z',
          tasks: [
            {
              kind: 'task',
              name: 'graph:check',
              status: 'running',
            },
            {
              kind: 'task',
              name: 'proof:check',
              status: 'planned',
            },
          ],
        },
      });

      await appendCheckIssues({
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
          result: 'running',
          tasks: [
            {
              kind: 'task',
              name: 'graph:check',
              status: 'running',
            },
            {
              kind: 'task',
              name: 'proof:check',
              status: 'planned',
            },
          ],
        },
      });

      await completeCheckIssueSnapshot({
        rootDir,
      });
      await appendCheckIssues({
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
          result: 'running',
          tasks: [
            {
              name: 'graph:check',
              status: 'running',
            },
            {
              name: 'proof:check',
              status: 'planned',
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
