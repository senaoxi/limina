import type { ResolvedLiminaConfig } from '#config/runner';
import { describe, expect, it } from 'vitest';

import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { formatCheckIssueHumanReport } from '../check-reporting/human';
import {
  createGraphCheckIssueFromFinding,
  type GraphReferenceMissingFinding,
} from '../graph-check/findings';

const config = {
  configPath: '/repo/limina.config.mts',
  rootDir: '/repo',
} as ResolvedLiminaConfig;

const ANSI_ESCAPE = String.fromCodePoint(0x1b);
const ANSI_PATTERN = new RegExp(
  String.raw`${ANSI_ESCAPE}\[[\d:;<=>?]*[\u0020-\u002F]*[\u0040-\u007E]`,
  'gu',
);

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_PATTERN, '');
}

const finding: GraphReferenceMissingFinding = {
  checkerName: 'typescript',
  code: LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing,
  evidence: [
    {
      label: 'semantic-only evidence',
      value: '@example/lib',
    },
  ],
  facts: {
    expectedReferencePath: '/repo/packages/lib/tsconfig.lib.dts.json',
    imports: [
      {
        filePath: '/repo/packages/app/src/index.ts',
        kind: 'static-import',
        line: 3,
        specifier: '@example/lib',
      },
    ],
    projectPath: '/repo/packages/app/tsconfig.lib.dts.json',
  },
  filePath: '/repo/packages/app/tsconfig.lib.dts.json',
  locations: [
    {
      filePath: '/repo/packages/app/tsconfig.lib.dts.json',
      label: 'importing project',
    },
    {
      filePath: '/repo/packages/lib/tsconfig.lib.dts.json',
      label: 'expected reference',
    },
  ],
  presentation: {
    detailLines: [
      'Missing project reference for workspace import:',
      '  importing project: packages/app/tsconfig.lib.dts.json',
      '  expected reference: packages/lib/tsconfig.lib.dts.json',
    ],
    reason: 'A static workspace import requires a declaration reference.',
    title: 'Missing project reference for workspace import',
  },
  task: 'graph:check',
};

describe('typed Graph finding formatter', () => {
  it('keeps the established detail block while retaining structured evidence', () => {
    const issue = createGraphCheckIssueFromFinding({ config, finding });
    const output = stripAnsi(
      formatCheckIssueHumanReport({
        color: true,
        issues: [issue],
        title: 'Graph check summary',
      }),
    );

    expect(output).toContain('Missing project reference for workspace import');
    expect(output).toContain('rule: LIMINA_GRAPH_REFERENCE_MISSING');
    expect(output).toContain('task: graph:check');
    expect(output).toContain(
      'importing project: packages/app/tsconfig.lib.dts.json',
    );
    expect(output).not.toContain('semantic-only evidence');
    expect(issue.evidence).toEqual(finding.evidence);
  });

  it('allows display wording to change without changing code or task', () => {
    const originalIssue = createGraphCheckIssueFromFinding({ config, finding });
    const revisedIssue = createGraphCheckIssueFromFinding({
      config,
      finding: {
        ...finding,
        presentation: {
          ...finding.presentation,
          detailLines: ['Reformatted diagnostic:', '  path => display-only'],
          title: 'Reformatted missing reference',
        },
      },
    });
    const originalOutput = formatCheckIssueHumanReport({
      color: true,
      issues: [originalIssue],
      title: 'Graph check summary',
    });
    const revisedOutput = formatCheckIssueHumanReport({
      color: true,
      issues: [revisedIssue],
      title: 'Graph check summary',
    });

    expect(revisedOutput).not.toBe(originalOutput);
    expect(revisedIssue.code).toBe(originalIssue.code);
    expect(revisedIssue.task).toBe(originalIssue.task);
  });
});
