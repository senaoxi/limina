import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'pathe';
import { describe, expect, it } from 'vitest';
import {
  assertIssueTaskMatchesCode,
  DEFAULT_ISSUE_CODE_BY_TASK,
  getLiminaCheckIssueRuleMetadata,
  LIMINA_CHECK_ISSUE_CODES,
  listLiminaCheckIssueCodes,
  listLiminaCheckIssueRuleMetadata,
} from '../check-reporting/codes';
import {
  LIMINA_CHECK_ISSUE_DETECTOR_COVERAGE,
  LIMINA_DETECTOR_SCENARIO_COVERAGE,
} from '../check-reporting/detector-coverage';
import { createLiminaCheckIssue } from '../check-reporting/structured';
import {
  LIMINA_CHECK_TASK_NAMES,
  type LiminaCheckTaskName,
} from '../source-check/snapshot';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '../../../..');

function readWorkspaceFile(filePath: string): string {
  return readFileSync(path.join(WORKSPACE_ROOT, filePath), 'utf8');
}

describe('Limina issue code contracts', () => {
  it('keeps canonical metadata and detector coverage exhaustive', () => {
    const codes = listLiminaCheckIssueCodes();
    const coverageCodes = Object.keys(
      LIMINA_CHECK_ISSUE_DETECTOR_COVERAGE,
    ).sort();
    const metadata = listLiminaCheckIssueRuleMetadata();

    expect(codes).toHaveLength(62);
    expect(coverageCodes).toEqual(codes);
    expect(metadata.map((entry) => entry.code).sort()).toEqual(codes);
    expect(new Set(metadata.map((entry) => entry.task))).toEqual(
      new Set(LIMINA_CHECK_TASK_NAMES),
    );
    expect(
      Object.fromEntries(
        [...new Set(metadata.map((entry) => entry.status))]
          .sort()
          .map((status) => [
            status,
            metadata.filter((entry) => entry.status === status).length,
          ]),
      ),
    ).toEqual({ active: 60, planned: 1, retired: 1 });
    expect(LIMINA_CHECK_TASK_NAMES).toHaveLength(11);
  });

  it('records legal coverage states and locatable producers and tests', () => {
    const kindCounts = new Map<string, number>();

    for (const [code, entry] of Object.entries(
      LIMINA_CHECK_ISSUE_DETECTOR_COVERAGE,
    )) {
      kindCounts.set(entry.kind, (kindCounts.get(entry.kind) ?? 0) + 1);
      const metadata = getLiminaCheckIssueRuleMetadata(
        code as keyof typeof LIMINA_CHECK_ISSUE_DETECTOR_COVERAGE,
      );
      expect(entry.task).toBe(metadata.task);
      expect(metadata.status).toBe(
        entry.kind === 'planned'
          ? 'planned'
          : entry.kind === 'retired'
            ? 'retired'
            : 'active',
      );

      if (entry.kind === 'retired') {
        expect(entry.reason.trim()).not.toBe('');
        continue;
      }

      expect(entry.producers.length).toBeGreaterThan(0);
      for (const producer of entry.producers) {
        const [filePath, symbol] = producer.split('#');
        expect(filePath).toMatch(/^packages\/limina\/src\/.+\.ts$/u);
        expect(symbol).toBeTruthy();
        expect(existsSync(path.join(WORKSPACE_ROOT, filePath!))).toBe(true);
        expect(readWorkspaceFile(filePath!)).toContain(symbol);
      }

      if (entry.kind === 'planned') {
        expect(entry.reason.trim()).not.toBe('');
        continue;
      }

      if (entry.kind === 'unit') {
        expect(entry.reason.trim()).not.toBe('');
      }

      expect(entry.tests.length).toBeGreaterThan(0);
      for (const testPath of entry.tests) {
        expect(existsSync(path.join(WORKSPACE_ROOT, testPath))).toBe(true);
      }
    }

    expect(Object.fromEntries([...kindCounts].sort())).toEqual({
      'external-tool': 5,
      'fault-injection': 11,
      fixture: 37,
      integration: 2,
      planned: 1,
      retired: 1,
      unit: 5,
    });

    expect(Object.keys(LIMINA_DETECTOR_SCENARIO_COVERAGE)).toHaveLength(19);
    for (const [id, scenario] of Object.entries(
      LIMINA_DETECTOR_SCENARIO_COVERAGE,
    )) {
      expect(scenario.fixturePath).toBe(
        `packages/limina/fixtures/detectors/${id}/case.mts`,
      );
      expect(existsSync(path.join(WORKSPACE_ROOT, scenario.fixturePath))).toBe(
        true,
      );
      expect(scenario.reason.trim()).not.toBe('');
    }
  });

  it('maps every task fallback explicitly to its canonical failure code', () => {
    const expected = {
      'checker:build': LIMINA_CHECK_ISSUE_CODES.checkerBuildFailed,
      'checker:typecheck': LIMINA_CHECK_ISSUE_CODES.checkerTypecheckFailed,
      command: LIMINA_CHECK_ISSUE_CODES.commandFailed,
      'graph:check': LIMINA_CHECK_ISSUE_CODES.graphCheckFailed,
      'graph:materialize': LIMINA_CHECK_ISSUE_CODES.graphMaterializeFailed,
      'graph:prepare': LIMINA_CHECK_ISSUE_CODES.graphPrepareFailed,
      'package:check': LIMINA_CHECK_ISSUE_CODES.packageCheckFailed,
      'proof:check': LIMINA_CHECK_ISSUE_CODES.proofCheckFailed,
      'release:check': LIMINA_CHECK_ISSUE_CODES.releaseCheckFailed,
      'source:check': LIMINA_CHECK_ISSUE_CODES.sourceCheckFailed,
      'workspace:validate': LIMINA_CHECK_ISSUE_CODES.workspaceValidationFailed,
    } as const satisfies Record<LiminaCheckTaskName, string>;

    expect(DEFAULT_ISSUE_CODE_BY_TASK).toEqual(expected);

    for (const task of LIMINA_CHECK_TASK_NAMES) {
      const issue = createLiminaCheckIssue({ rootDir: '/repo', task });

      expect(issue.code).toBe(expected[task]);
      expect(getLiminaCheckIssueRuleMetadata(issue.code).task).toBe(task);
    }
  });

  it('rejects unknown, planned, retired, and code/task-mismatched internal issues', () => {
    expect(() =>
      createLiminaCheckIssue({
        // @ts-expect-error Unknown wire codes are reader-only, not creator input.
        code: 'LIMINA_NOT_REGISTERED',
        rootDir: '/repo',
        task: 'source:check',
      }),
    ).toThrow('Unknown canonical Limina issue code');

    expect(() =>
      createLiminaCheckIssue({
        // @ts-expect-error Planned codes are not current writer input.
        code: LIMINA_CHECK_ISSUE_CODES.releaseConsistency,
        rootDir: '/repo',
        task: 'release:check',
      }),
    ).toThrow('Planned Limina issue code is not writable');

    expect(() =>
      createLiminaCheckIssue({
        // @ts-expect-error Retired aliases are reader-only, not creator input.
        code: LIMINA_CHECK_ISSUE_CODES.pipelineCommandFailed,
        rootDir: '/repo',
        task: 'command',
      }),
    ).toThrow('Retired Limina issue code is read-only');

    expect(() =>
      createLiminaCheckIssue({
        code: LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap,
        rootDir: '/repo',
        task: 'source:check',
      }),
    ).toThrow(
      'Issue code LIMINA_WORKSPACE_REGION_OVERLAP belongs to workspace:validate, not source:check.',
    );

    expect(() =>
      assertIssueTaskMatchesCode(
        LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap,
        'workspace:validate',
      ),
    ).not.toThrow();
  });

  it('keeps region overlap owned by workspace validation only', () => {
    expect(
      LIMINA_CHECK_ISSUE_DETECTOR_COVERAGE[
        LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap
      ],
    ).toMatchObject({
      producers: [
        'packages/limina/src/core/workspace/validated-context.ts#createWorkspaceIssue',
      ],
      task: 'workspace:validate',
    });
    expect(
      readWorkspaceFile('packages/limina/src/source-check/runner.ts'),
    ).not.toContain('workspaceRegionOverlap');
  });

  it.each([
    ['planned release code', LIMINA_CHECK_ISSUE_CODES.releaseConsistency],
    ['retired pipeline alias', LIMINA_CHECK_ISSUE_CODES.pipelineCommandFailed],
  ] as const)('keeps the %s producer-free', (_name, nonActiveCode) => {
    const sourceRoot = path.join(WORKSPACE_ROOT, 'packages/limina/src');
    const references = readdirSync(sourceRoot, { recursive: true })
      .map(String)
      .filter(
        (filePath) =>
          filePath.endsWith('.ts') &&
          !filePath.includes('__tests__') &&
          ![
            'check-reporting/codes.ts',
            'check-reporting/detector-coverage.ts',
          ].includes(filePath),
      )
      .filter((filePath) =>
        readFileSync(path.join(sourceRoot, filePath), 'utf8').includes(
          nonActiveCode,
        ),
      );

    expect(references).toEqual([]);
  });
});
