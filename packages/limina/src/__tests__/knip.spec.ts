import { describe, expect, it } from 'vitest';
import {
  collectUnusedSourceFileIssues,
  parseKnipJsonReport,
  resolveKnipCliPath,
} from '../knip';

describe('parseKnipJsonReport', () => {
  it('accepts Knip JSON reports with leading stdout noise', () => {
    const report = parseKnipJsonReport(
      [
        '@example/env: loaded',
        '{"issues":[{"file":"package.json","dependencies":[{"name":"@example/internal"}],"devDependencies":[],"optionalPeerDependencies":[]}]}',
      ].join('\n'),
    );

    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.file).toBe('package.json');
  });

  it('rejects output that does not contain a Knip JSON report', () => {
    expect(() => parseKnipJsonReport('not json')).toThrow(
      'Failed to parse Knip JSON report.',
    );
  });
});

describe('collectUnusedSourceFileIssues', () => {
  it('maps JSON reporter files issues to absolute file paths', () => {
    const report = parseKnipJsonReport(
      '{"issues":[{"file":"packages/app/src/dead.ts","files":[{"name":"packages/app/src/dead.ts"}]}]}',
    );

    expect(
      collectUnusedSourceFileIssues({
        report,
        rootDir: '/repo',
      }),
    ).toEqual([
      {
        filePath: '/repo/packages/app/src/dead.ts',
      },
    ]);
  });

  it('maps files issues when stdout contains leading noise', () => {
    const report = parseKnipJsonReport(
      [
        'loaded env from .env',
        '{"issues":[{"file":"packages/app/src/dead.ts","files":[{"name":"packages/app/src/dead.ts"}]}]}',
      ].join('\n'),
    );

    expect(
      collectUnusedSourceFileIssues({
        report,
        rootDir: '/repo',
      }),
    ).toEqual([
      {
        filePath: '/repo/packages/app/src/dead.ts',
      },
    ]);
  });
});

describe('resolveKnipCliPath', () => {
  it('reports Knip as a missing peer dependency when resolution fails', () => {
    expect(() =>
      resolveKnipCliPath(() => {
        throw new Error('Cannot find package "knip"');
      }),
    ).toThrow(
      'Missing peer dependency "knip" required by limina source check.',
    );
  });
});
