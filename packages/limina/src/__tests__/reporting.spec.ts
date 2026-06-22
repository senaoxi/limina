import { describe, expect, it } from 'vitest';
import { formatCheckIssueHumanReport } from '../check-reporting/human';
import {
  formatCheckDetailBlock,
  formatCheckIssueSummaryReport,
  formatCheckSummaryBlock,
} from '../reporting';

const ANSI_ESCAPE = String.fromCodePoint(0x1b);
const ANSI_PATTERN = new RegExp(
  String.raw`${ANSI_ESCAPE}\[[\d:;<=>?]*[\u0020-\u002F]*[\u0040-\u007E]`,
  'gu',
);

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_PATTERN, '');
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

describe('check reporting', () => {
  it('formats left-aligned titled summary boxes for check tasks', () => {
    const lines = formatCheckSummaryBlock({
      lines: [
        'Found 2 graph check issues.',
        'Found 1 failed checker build target.',
        'By rule: limina check --issues --rule LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED --verbose',
      ],
      title: 'Graph check summary',
    });
    const plainLines = lines.map(stripAnsi);

    expect(plainLines.every((line) => line.length === 88)).toBe(true);
    expect(plainLines[0]).toContain('Graph check summary');
    expect(plainLines[1]).toMatch(/^│ Found 2 graph check issues\.\s+│$/u);
    expect(plainLines[2]).toMatch(
      /^│ Found 1 failed checker build target\.\s+│$/u,
    );
    expect(plainLines[3]).toMatch(
      /^│ By rule: limina check --issues --rule LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED\s+│$/u,
    );
    expect(plainLines[4]).toMatch(/^│ {10}--verbose\s+│$/u);
    expect(plainLines.slice(1, 3).map((line) => line.indexOf('Found'))).toEqual(
      [2, 2],
    );
  });

  it('accepts semantic colors for summary box labels', () => {
    const report = formatCheckSummaryBlock({
      borderColor: 'green',
      lines: [
        'Command: limina check',
        'Verbose: limina check --issues --verbose',
        'Fix steps: rebuild the package output',
        'By rule: limina check --issues --rule LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED',
        'Reason: source imports must be authorized.',
      ],
      title: 'Limina check summary',
    }).join('\n');
    const plainReport = stripAnsi(report);

    expect(plainReport).toContain('Limina check summary');
    expect(plainReport).toContain('Command: limina check');
    expect(report).toContain('\u001B[36mCommand:\u001B[0m limina check');
    expect(report).toContain(
      '\u001B[35mVerbose:\u001B[0m limina check --issues --verbose',
    );
    expect(report).toContain(
      '\u001B[32mFix steps:\u001B[0m rebuild the package output',
    );
    expect(report).toContain('\u001B[34mBy rule:\u001B[0m limina check');
    expect(report).toContain(
      '\u001B[33mReason:\u001B[0m source imports must be authorized.',
    );
  });

  it('formats detail blocks with the same left-aligned box shape', () => {
    const lines = formatCheckDetailBlock([
      'Source files are not covered by typecheck proof:',
      '  - packages/pkg/src/internal.ts',
      '  reason: every file must be covered.',
    ]);

    expect(lines[0]).toMatch(/^┌/u);
    expect(lines[1]).toMatch(
      /^│ Source files are not covered by typecheck proof:\s+│$/u,
    );
    expect(lines[2]).toMatch(/^│ {3}- packages\/pkg\/src\/internal\.ts\s+│$/u);
  });

  it('wraps graph check detail prose inside the standard block width', () => {
    const lines = formatCheckDetailBlock([
      'Unresolved workspace import:',
      '  import: @example/missing',
      '  reason: graph check reports resolver and architecture violations with enough context, but long explanations should wrap instead of widening the terminal report.',
    ]);
    const report = lines.join('\n');

    expect(lines.every((line) => line.length === 88)).toBe(true);
    expect(report).toContain(
      '│   reason: graph check reports resolver and architecture violations with enough',
    );
    expect(report).toContain(
      '│           context, but long explanations should wrap instead of widening the',
    );
  });

  it('prepends a summary box before detailed check reports', () => {
    const report = formatCheckIssueSummaryReport({
      details: 'detail line 1\n\ndetail line 2',
      issueCount: 2,
      pluralIssueLabel: 'proof check issues',
      singularIssueLabel: 'proof check issue',
      title: 'Proof check summary',
    });

    expect(report).toMatch(/^╭ Proof check summary /u);
    expect(report).toContain('│ Found 2 proof check issues.');
    expect(report).toContain('│ detail line 1');
    expect(report).toContain('│ detail line 2');
    expect(report).not.toContain('\n\ndetail line 1\n\n');
  });

  it('groups structured check issues and truncates details by default', () => {
    const report = formatCheckIssueHumanReport({
      command: 'limina graph check',
      issues: Array.from({ length: 46 }, (_, index) => ({
        code: 'LIMINA_GRAPH_REFERENCE_MISSING',
        filePath: `packages/app/src/file-${index.toString().padStart(2, '0')}.ts`,
        fix: 'Run `limina graph prepare`.',
        packageName: '@example/app',
        reason: 'A workspace source import needs a project reference.',
        scope: 'packages/app/src',
        task: 'graph:check',
        title: 'Missing project reference for workspace import',
      })),
      title: 'Graph check summary',
    });
    const plainReport = stripAnsi(report);

    expect(plainReport).toContain('│ Found 46 check issues.');
    expect(plainReport).toContain(
      '│ Top rules: LIMINA_GRAPH_REFERENCE_MISSING (46)',
    );
    expect(plainReport).toContain(
      '│ Show all details: limina graph check --verbose',
    );
    expect(plainReport).toContain(
      '│ Missing project reference for workspace import  46 issues',
    );
    expect(plainReport).toContain('│ files:');
    expect(plainReport).toContain('│   - packages/app/src/file-00.ts');
    expect(plainReport).toContain('│   - packages/app/src/file-04.ts');
    expect(plainReport).not.toContain('│   - packages/app/src/file-05.ts');
    expect(plainReport).toContain('│   ... 41 more');
  });

  it('shows every structured check issue detail in verbose mode', () => {
    const report = formatCheckIssueHumanReport({
      command: 'limina proof check',
      issues: [
        {
          code: 'LIMINA_PROOF_CHECKER_COVERAGE_INVALID',
          detailLines: [
            'Checker entry is not reachable:',
            '  config: packages/app/tsconfig.json',
            '  reason: checker.include must reach source configs.',
          ],
          reason: 'Checker graph coverage is invalid.',
          task: 'proof:check',
          title: 'Checker coverage issue',
        },
      ],
      title: 'Proof check summary',
      verbose: true,
    });
    const plainReport = stripAnsi(report);

    expect(plainReport).toContain('│ Found 1 check issue.');
    expect(plainReport).toContain('│ details:');
    expect(plainReport).toContain('Checker entry is not reachable:');
    expect(plainReport).toContain(
      'reason: checker.include must reach source configs.',
    );
    expect(plainReport).not.toContain('Show all details');
  });

  it('deduplicates detail lines that exactly match evidence lines', () => {
    const diagnosticLines = [
      'Tsconfig search cannot determine module owner:',
      '  file: packages/vite/src/types/alias.d.ts',
      '  reason: no tsconfig includes the module.',
    ];
    const report = formatCheckIssueHumanReport({
      command: 'limina check',
      issues: [
        {
          code: 'LIMINA_SOURCE_TSCONFIG_SEARCH_CANNOT_DETERMINE_MODULE_OWNER',
          detailLines: diagnosticLines,
          evidence: [{ label: 'diagnostic', lines: diagnosticLines }],
          reason: 'no tsconfig includes the module.',
          task: 'source:check',
          title: 'Tsconfig search cannot determine module owner',
        },
      ],
      title: 'Check issue details',
      verbose: true,
    });
    const plainReport = stripAnsi(report);

    expect(plainReport).toContain('evidence:');
    expect(
      countOccurrences(
        plainReport,
        'Tsconfig search cannot determine module owner:',
      ),
    ).toBe(1);
  });

  it('colors structured check issue titles and section headings', () => {
    const report = formatCheckIssueHumanReport({
      command: 'limina source check',
      issues: [
        {
          code: 'LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED',
          detector: 'source',
          evidence: [
            {
              label: 'diagnostic',
              lines: [
                'source owner: packages/css/package.json',
                'reason: source imports must be authorized.',
                'fix: declare the dependency.',
              ],
            },
          ],
          filePath: 'packages/css/src/preprocessors.ts',
          fixSteps: ['Declare the dependency in packages/css/package.json.'],
          packageManifestPath: 'packages/css/package.json',
          packageName: '@tsdown/css',
          reason: 'source imports must be authorized.',
          severity: 'error',
          summary: 'Unauthorized bare package import',
          task: 'source:check',
          title: 'Unauthorized bare package import',
          tool: 'limina',
          verifyCommands: ['limina source check'],
        },
      ],
      title: 'Check issue details',
      verbose: true,
    });

    expect(report).toContain(
      '\u001B[31mUnauthorized bare package import\u001B[0m  1 issue',
    );
    expect(report).toContain('\u001B[36mpackage:\u001B[0m @tsdown/css');
    expect(report).toContain('\u001B[34mrule:\u001B[0m');
    expect(report).toContain('\u001B[36msummary:\u001B[0m');
    expect(report).toContain('\u001B[33mreason:\u001B[0m');
    expect(report).toContain('\u001B[32mfix steps:\u001B[0m');
    expect(report).toContain('\u001B[36mverify:\u001B[0m');
    expect(report).toContain('\u001B[35mevidence:\u001B[0m');
    expect(report).toContain('\u001B[36msource owner:\u001B[0m');
    expect(report).toContain('\u001B[32mfix:\u001B[0m');
  });
});
