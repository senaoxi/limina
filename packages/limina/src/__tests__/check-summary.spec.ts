import { describe, expect, it } from 'vitest';
import { createLiminaCheckIssue } from '../check-reporting/structured';
import {
  type CheckTopBlocker,
  createIssueOverview,
  formatCheckRunSummaryHuman,
  selectTopBlockers,
} from '../check-reporting/summary';
import type { CheckIssueSnapshot } from '../source-check/snapshot';

const ANSI_ESCAPE = String.fromCodePoint(0x1b);
const ANSI_PATTERN = new RegExp(
  String.raw`${ANSI_ESCAPE}\[[\d:;<=>?]*[\u0020-\u002F]*[\u0040-\u007E]`,
  'gu',
);

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_PATTERN, '');
}

function createIssue(options: {
  code: string;
  filePath?: string;
  fixSteps?: string[];
  packageName?: string;
  task: 'graph:check' | 'proof:check' | 'source:check';
  title: string;
}) {
  return createLiminaCheckIssue({
    code: options.code,
    filePath: options.filePath,
    fixSteps: options.fixSteps,
    packageName: options.packageName,
    reason: `${options.title} failed.`,
    rootDir: '/repo',
    task: options.task,
    title: options.title,
  });
}

describe('check run summary reporting', () => {
  it('creates issue overview counts for result and impact fields', () => {
    const overview = createIssueOverview([
      createIssue({
        code: 'LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED',
        filePath: '/repo/packages/app/src/index.ts',
        packageName: '@example/app',
        task: 'source:check',
        title: 'Unauthorized bare package import',
      }),
      createIssue({
        code: 'LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED',
        filePath: '/repo/packages/app/src/theme.ts',
        packageName: '@example/app',
        task: 'source:check',
        title: 'Unauthorized bare package import',
      }),
      createIssue({
        code: 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE',
        filePath: '/repo/packages/shared/src/index.ts',
        packageName: '@example/shared',
        task: 'proof:check',
        title: 'Uncovered source file',
      }),
    ]);

    expect(overview.issueCount).toBe(3);
    expect(overview.affectedPackages).toBe(2);
    expect(overview.affectedScopes).toBe(2);
    expect(overview.affectedFiles).toBe(3);
    expect(overview.tasks[0]).toEqual({
      count: 2,
      name: 'source:check',
    });
    expect(overview.rules[0]).toEqual({
      count: 2,
      name: 'LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED',
    });
  });

  it('selects at most five top blockers by severity, count, and impact', () => {
    const issues = [
      createIssue({
        code: 'RULE_A',
        filePath: '/repo/packages/app/src/a.ts',
        packageName: '@example/app',
        task: 'source:check',
        title: 'Rule A',
      }),
      createIssue({
        code: 'RULE_A',
        filePath: '/repo/packages/app/src/b.ts',
        packageName: '@example/app',
        task: 'source:check',
        title: 'Rule A',
      }),
      createIssue({
        code: 'RULE_A',
        filePath: '/repo/packages/lib/src/a.ts',
        packageName: '@example/lib',
        task: 'source:check',
        title: 'Rule A',
      }),
      createIssue({
        code: 'RULE_A',
        filePath: '/repo/packages/lib/src/a-variant.ts',
        packageName: '@example/lib',
        task: 'source:check',
        title: 'Rule A variant',
      }),
      createIssue({
        code: 'RULE_B',
        filePath: '/repo/packages/app/src/c.ts',
        packageName: '@example/app',
        task: 'graph:check',
        title: 'Rule B',
      }),
      createIssue({
        code: 'RULE_C',
        filePath: '/repo/packages/lib/src/c.ts',
        packageName: '@example/lib',
        task: 'proof:check',
        title: 'Rule C',
      }),
      createIssue({
        code: 'RULE_D',
        filePath: '/repo/packages/lib/src/d.ts',
        packageName: '@example/lib',
        task: 'proof:check',
        title: 'Rule D',
      }),
      createIssue({
        code: 'RULE_E',
        filePath: '/repo/packages/lib/src/e.ts',
        packageName: '@example/lib',
        task: 'proof:check',
        title: 'Rule E',
      }),
      createIssue({
        code: 'RULE_F',
        filePath: '/repo/packages/lib/src/f.ts',
        packageName: '@example/lib',
        task: 'proof:check',
        title: 'Rule F',
      }),
    ];
    const blockers = selectTopBlockers(issues);

    expect(blockers).toHaveLength(5);
    expect(blockers[0]).toMatchObject({
      affectedPackages: 2,
      code: 'RULE_A',
      count: 4,
      packages: [
        {
          count: 2,
          name: '@example/app',
        },
        {
          count: 2,
          name: '@example/lib',
        },
      ],
      task: 'source:check',
    });
    expect(
      blockers.filter((blocker) => blocker.code === 'RULE_A'),
    ).toHaveLength(1);
    expect(
      blockers.map((blocker: CheckTopBlocker) => blocker.code),
    ).not.toContain('RULE_F');
  });

  it('formats a human run summary with task state and next commands', () => {
    const issue = createIssue({
      code: 'LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED',
      filePath: '/repo/packages/app/src/index.ts',
      fixSteps: [
        'Declare "@components/shared" in docs/package.json dependencies.',
      ],
      packageName: '@example/app',
      task: 'source:check',
      title: 'Unauthorized bare package import',
    });
    const snapshot: CheckIssueSnapshot = {
      command: 'limina check',
      createdAt: '2026-06-20T00:00:00.000Z',
      issues: [issue],
      run: {
        command: 'limina check',
        completedAt: '2026-06-20T00:00:03.000Z',
        configPath: '/repo/limina.config.mjs',
        createdAt: '2026-06-20T00:00:00.000Z',
        durationMs: 3000,
        pipeline: 'default',
        result: 'failed',
        startedAt: '2026-06-20T00:00:00.000Z',
        tasks: [
          {
            checkItems: [
              {
                checksPassed: 37,
                checksTotal: 37,
                issues: 0,
                itemKind: 'check',
                name: 'project references',
                status: 'passed',
              },
            ],
            checksPassed: 37,
            checksTotal: 37,
            completedAt: '2026-06-20T00:00:01.000Z',
            durationMs: 1000,
            generation: 0,
            id: 'graph',
            issueTask: 'graph:check',
            kind: 'task',
            label: 'graph:check',
            startedAt: '2026-06-20T00:00:00.000Z',
            state: 'passed',
          },
          {
            checkItems: [
              {
                checksPassed: 0,
                checksTotal: 37,
                issues: 1,
                itemKind: 'check',
                name: 'source import authority',
                status: 'failed',
              },
            ],
            checksPassed: 0,
            checksTotal: 37,
            completedAt: '2026-06-20T00:00:02.000Z',
            durationMs: 1000,
            generation: 0,
            id: 'source',
            issueTask: 'source:check',
            kind: 'task',
            label: 'source:check',
            reason: 'source:check failed',
            startedAt: '2026-06-20T00:00:01.000Z',
            state: 'failed',
          },
          {
            checksPassed: 37,
            checksTotal: 37,
            completedAt: '2026-06-20T00:00:03.000Z',
            durationMs: 1000,
            generation: 0,
            id: 'proof',
            issueTask: 'proof:check',
            kind: 'task',
            label: 'proof:check',
            startedAt: '2026-06-20T00:00:02.000Z',
            state: 'passed',
          },
        ],
      },
      status: 'completed',
      version: 7,
    };
    const output = formatCheckRunSummaryHuman({
      issues: snapshot.issues,
      rootDir: '/repo',
      run: snapshot.run!,
    });
    const plainOutput = stripAnsi(output);

    expect(plainOutput).toContain('Limina check summary');
    expect(plainOutput).not.toContain('Result: FAILED');
    expect(plainOutput).toContain('Command: limina check');
    expect(output).toContain('\u001B[36mCommand:\u001B[0m limina check');
    expect(plainOutput).toContain('Config: limina.config.mjs');
    expect(plainOutput).toContain('Duration: 3.0s');
    expect(plainOutput).toContain('Executed tasks: 3 / 3');
    expect(plainOutput).toContain('Passed tasks: 2 / 3');
    expect(plainOutput).toContain('Open issues: 1');
    expect(plainOutput).not.toContain('Adaptation:');
    expect(plainOutput).not.toContain('Not reached after: source:check');
    expect(plainOutput).not.toContain('Blocked at: source:check');
    expect(plainOutput).toContain('Snapshot: .limina/check/last-run.json');
    expect(plainOutput).toContain('Validation units:');
    expect(output).toContain('\u001B[36mValidation units:\u001B[0m');
    expect(plainOutput).toContain('✓ graph:check');
    expect(output).toContain(
      `${ANSI_ESCAPE}[32m✓ graph:check${ANSI_ESCAPE}[0m`,
    );
    expect(plainOutput).toContain('✓ project references');
    expect(output).toContain(
      `${ANSI_ESCAPE}[32m✓ project references${ANSI_ESCAPE}[0m`,
    );
    expect(plainOutput).toContain('✕ source:check');
    expect(output).toContain(
      `${ANSI_ESCAPE}[31m✕ source:check${ANSI_ESCAPE}[0m`,
    );
    expect(plainOutput).toContain('✕ source import authority');
    expect(output).toContain(
      `${ANSI_ESCAPE}[31m✕ source import authority${ANSI_ESCAPE}[0m`,
    );
    expect(plainOutput).toContain('units 37');
    expect(plainOutput).toMatch(/issues\s+1/u);
    expect(plainOutput).not.toContain('skipped');
    expect(plainOutput).toContain('proof:check');
    expect(plainOutput).toContain('Issue overview:');
    expect(output).toContain('\u001B[35mIssue overview:\u001B[0m');
    expect(plainOutput).toContain('Total: 1 error');
    expect(plainOutput).toContain('Top blockers:');
    expect(plainOutput).toContain('Packages: @example/app (1)');
    expect(plainOutput).not.toContain('Fix:');
    expect(plainOutput).not.toContain(
      'Declare "@components/shared" in docs/package.json dependencies.',
    );
    expect(plainOutput).toContain('Next commands:');
    expect(plainOutput).toContain(
      'limina check --issues --task source:check --verbose',
    );
    expect(plainOutput).toContain('limina check --issues --format json');
    expect(plainOutput).toContain(
      'By rule: limina check --issues --rule LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED',
    );
    expect(plainOutput).toContain('--verbose');
  });

  it('uses the stable issue task in next commands for custom commands', () => {
    const label = 'node -e "process.exit(7)" --label "two words"';
    const issue = createLiminaCheckIssue({
      code: 'LIMINA_COMMAND_FAILED',
      reason: 'custom command failed',
      rootDir: '/repo',
      task: 'command',
      title: 'Pipeline command failed',
    });
    const output = stripAnsi(
      formatCheckRunSummaryHuman({
        issues: [issue],
        rootDir: '/repo',
        run: {
          blockedBy: { id: 'custom-command', label },
          command: 'limina check custom',
          completedAt: '2026-07-17T00:00:01.000Z',
          configPath: '/repo/limina.config.mjs',
          createdAt: '2026-07-17T00:00:00.000Z',
          result: 'failed',
          tasks: [
            {
              completedAt: '2026-07-17T00:00:01.000Z',
              generation: 0,
              id: 'custom-command',
              issueTask: 'command',
              kind: 'command',
              label,
              state: 'failed',
            },
          ],
        },
      }),
    );

    expect(output).toContain(`Blocked at: ${label}`);
    expect(output).toContain(label);
    expect(output).toContain('limina check --issues --task command --verbose');
    expect(output).not.toContain(`--task ${label}`);
  });

  it('sums child check counts for task rows and abbreviates large values', () => {
    const issue = createIssue({
      code: 'LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED',
      filePath: '/repo/packages/app/src/index.ts',
      packageName: '@example/app',
      task: 'source:check',
      title: 'Unauthorized bare package import',
    });
    const snapshot: CheckIssueSnapshot = {
      command: 'limina check',
      createdAt: '2026-06-20T00:00:00.000Z',
      issues: [issue],
      run: {
        command: 'limina check',
        completedAt: '2026-06-20T00:00:03.000Z',
        configPath: '/repo/limina.config.mjs',
        createdAt: '2026-06-20T00:00:00.000Z',
        durationMs: 3000,
        pipeline: 'default',
        result: 'failed',
        startedAt: '2026-06-20T00:00:00.000Z',
        tasks: [
          {
            checkItems: [
              {
                checksPassed: 1200,
                checksTotal: 1200,
                issues: 0,
                itemKind: 'check',
                name: 'source graph routes',
                status: 'passed',
              },
              {
                checksPassed: 150,
                checksTotal: 300,
                issues: 1500,
                itemKind: 'check',
                name: 'source import authority',
                status: 'failed',
              },
            ],
            checksPassed: 0,
            checksTotal: 23,
            completedAt: '2026-06-20T00:00:03.000Z',
            durationMs: 3000,
            generation: 0,
            id: 'source',
            issueTask: 'source:check',
            kind: 'task',
            label: 'source:check',
            reason: 'source:check failed',
            startedAt: '2026-06-20T00:00:00.000Z',
            state: 'failed',
          },
        ],
      },
      status: 'completed',
      version: 7,
    };
    const output = formatCheckRunSummaryHuman({
      issues: snapshot.issues,
      rootDir: '/repo',
      run: snapshot.run!,
    });
    const plainOutput = stripAnsi(output);

    expect(plainOutput).toMatch(/✕ source:check\s+units\s+1\.5K\s+issues\s+1/u);
    expect(plainOutput).toMatch(
      /✓ source graph routes\s+units\s+1\.2K\s+issues\s+0/u,
    );
    expect(output).toContain(
      `${ANSI_ESCAPE}[32m✓ source graph routes${ANSI_ESCAPE}[0m`,
    );
    expect(plainOutput).toMatch(
      /✕ source import authority\s+units\s+300\s+issues\s+1\.5K/u,
    );
    expect(output).toContain(
      `${ANSI_ESCAPE}[31m✕ source import authority${ANSI_ESCAPE}[0m`,
    );
  });

  it('aligns unit count, issue count, and duration columns across failed task and child rows', () => {
    const issues = [
      createIssue({
        code: 'LIMINA_GRAPH_REFERENCE_MISSING',
        filePath: '/repo/packages/app/src/index.ts',
        packageName: '@example/app',
        task: 'graph:check',
        title: 'Missing project reference',
      }),
      createIssue({
        code: 'LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED',
        filePath: '/repo/packages/app/src/theme.ts',
        packageName: '@example/app',
        task: 'source:check',
        title: 'Unauthorized bare package import',
      }),
    ];
    const snapshot: CheckIssueSnapshot = {
      command: 'limina check',
      createdAt: '2026-06-20T00:00:00.000Z',
      issues,
      run: {
        command: 'limina check',
        completedAt: '2026-06-20T00:00:03.000Z',
        configPath: '/repo/limina.config.mjs',
        createdAt: '2026-06-20T00:00:00.000Z',
        durationMs: 3000,
        pipeline: 'default',
        result: 'failed',
        startedAt: '2026-06-20T00:00:00.000Z',
        tasks: [
          {
            checkItems: [
              {
                checksPassed: 2,
                checksTotal: 10,
                durationMs: 594,
                issues: 8,
                itemKind: 'check',
                name: 'source graph routes',
                status: 'failed',
              },
              {
                checksPassed: 465,
                checksTotal: 465,
                durationMs: 16,
                issues: 0,
                itemKind: 'check',
                name: 'project references',
                status: 'passed',
              },
            ],
            checksPassed: 467,
            checksTotal: 512,
            completedAt: '2026-06-20T00:00:01.000Z',
            durationMs: 8100,
            generation: 0,
            id: 'graph',
            issueTask: 'graph:check',
            kind: 'task',
            label: 'graph:check',
            startedAt: '2026-06-20T00:00:00.000Z',
            state: 'failed',
          },
          {
            checkItems: [
              {
                checksPassed: 2500,
                checksTotal: 4700,
                durationMs: 2400,
                issues: 32,
                itemKind: 'check',
                name: 'source import authority',
                status: 'failed',
              },
            ],
            checksPassed: 2500,
            checksTotal: 6200,
            completedAt: '2026-06-20T00:00:03.000Z',
            durationMs: 3700,
            generation: 0,
            id: 'source',
            issueTask: 'source:check',
            kind: 'task',
            label: 'source:check',
            startedAt: '2026-06-20T00:00:01.000Z',
            state: 'failed',
          },
        ],
      },
      status: 'completed',
      version: 7,
    };
    const output = formatCheckRunSummaryHuman({
      issues,
      rootDir: '/repo',
      run: snapshot.run!,
    });
    const checkLines = stripAnsi(output)
      .split('\n')
      .filter((line) => line.includes('units') && line.includes('issues'));
    const durationPattern = /\b(?:\d+ms|\d+\.\d+s)\b/u;

    expect(checkLines).toHaveLength(5);
    expect(new Set(checkLines.map((line) => line.indexOf('units'))).size).toBe(
      1,
    );
    expect(new Set(checkLines.map((line) => line.indexOf('issues'))).size).toBe(
      1,
    );
    expect(
      new Set(
        checkLines.map((line) => {
          const match = durationPattern.exec(line);

          return match?.index;
        }),
      ).size,
    ).toBe(1);
  });

  it('formats a passed run summary without issue sections', () => {
    const snapshot: CheckIssueSnapshot = {
      command: 'limina check',
      createdAt: '2026-06-20T00:00:00.000Z',
      issues: [],
      run: {
        command: 'limina check',
        completedAt: '2026-06-20T00:00:12.100Z',
        configPath: '/repo/limina.config.mjs',
        createdAt: '2026-06-20T00:00:00.000Z',
        durationMs: 12_100,
        pipeline: 'default',
        result: 'passed',
        startedAt: '2026-06-20T00:00:00.000Z',
        tasks: [
          {
            checksPassed: 37,
            checksTotal: 37,
            completedAt: '2026-06-20T00:00:01.100Z',
            durationMs: 1100,
            generation: 0,
            id: 'graph',
            issueTask: 'graph:check',
            kind: 'task',
            label: 'graph:check',
            startedAt: '2026-06-20T00:00:00.000Z',
            state: 'passed',
          },
          {
            checksPassed: 37,
            checksTotal: 37,
            completedAt: '2026-06-20T00:00:04.900Z',
            durationMs: 3800,
            generation: 0,
            id: 'source',
            issueTask: 'source:check',
            kind: 'task',
            label: 'source:check',
            startedAt: '2026-06-20T00:00:01.100Z',
            state: 'passed',
          },
        ],
      },
      status: 'completed',
      version: 7,
    };
    const output = formatCheckRunSummaryHuman({
      issues: snapshot.issues,
      rootDir: '/repo',
      run: snapshot.run!,
    });
    const plainOutput = stripAnsi(output);

    expect(plainOutput).toContain('Limina check summary');
    expect(plainOutput).not.toContain('Result: PASSED');
    expect(plainOutput).toContain('Duration: 12.1s');
    expect(output).toContain('\u001B[36mDuration:\u001B[0m 12.1s');
    expect(plainOutput).toContain('Executed tasks: 2 / 2');
    expect(plainOutput).toContain('Passed tasks: 2 / 2');
    expect(plainOutput).toContain('Open issues: 0');
    expect(plainOutput).not.toContain('Adaptation:');
    expect(plainOutput).toContain('Validation units:');
    expect(plainOutput).toContain('units 37');
    expect(plainOutput).toContain('✓ graph:check');
    expect(plainOutput).toContain('✓ source:check');
    expect(plainOutput).not.toContain('Snapshot:');
    expect(plainOutput).not.toContain('Issue overview:');
  });
});
