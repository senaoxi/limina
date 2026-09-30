import path from 'pathe';
import { describe, expect, it } from 'vitest';
import {
  isPathCandidatesMatchFileFilters,
  isPathCandidatesMatchScopeFilters,
  type PathFilterCandidate,
} from '../check-reporting/path-filters';
import { formatCheckIssueSnapshotInventory } from '../check-reporting/snapshot';
import { createLiminaCheckIssue } from '../check-reporting/structured';

function formatIssueIds(options: {
  files?: string[];
  rootDir: string;
  scopes?: string[];
}): string[] {
  const issue = createLiminaCheckIssue({
    code: 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE',
    filePath: path.join(
      options.rootDir,
      'packages',
      'a',
      'src',
      'nested',
      'file.ts',
    ),
    reason: 'not covered',
    rootDir: options.rootDir,
    task: 'proof:check',
    title: 'Uncovered source file',
  });
  const payload = JSON.parse(
    formatCheckIssueSnapshotInventory({
      filters: {
        files: options.files,
        scopes: options.scopes,
      },
      format: 'json',
      rootDir: options.rootDir,
      snapshot: {
        command: 'limina check',
        createdAt: '2026-07-17T00:00:00.000Z',
        issues: [issue],
        status: 'completed',
        version: 8,
      },
    }),
  ) as { issues: { id?: string }[] };

  return payload.issues.flatMap((item) => (item.id ? [item.id] : []));
}

describe('check issue path filters', () => {
  it('canonicalizes equivalent file and scope path representations', () => {
    const rootDirectory = path.resolve('path filter workspace');
    const relativeFile = 'packages/a/src/nested/file.ts';
    const absoluteFile = path.join(rootDirectory, ...relativeFile.split('/'));
    const expectedIds = formatIssueIds({
      files: [relativeFile],
      rootDir: rootDirectory,
    });

    for (const file of [
      relativeFile,
      `./${relativeFile}`,
      absoluteFile,
      relativeFile.replaceAll('/', '\\'),
    ]) {
      expect(formatIssueIds({ files: [file], rootDir: rootDirectory })).toEqual(
        expectedIds,
      );
    }

    for (const scope of [
      'packages/a/src',
      './packages/a/src',
      path.join(rootDirectory, 'packages', 'a', 'src'),
      'packages\\a\\src',
      'packages/a/**',
      'packages/**/src/**',
    ]) {
      expect(
        formatIssueIds({ rootDir: rootDirectory, scopes: [scope] }),
      ).toEqual(expectedIds);
    }
  });

  it('matches repeated scopes with OR semantics and reports zero matches', () => {
    const rootDirectory = path.resolve('path filter workspace');

    expect(
      formatIssueIds({
        rootDir: rootDirectory,
        scopes: ['packages/missing/**', 'packages/a/**'],
      }),
    ).toHaveLength(1);
    expect(
      formatIssueIds({
        rootDir: rootDirectory,
        scopes: ['packages/missing/**'],
      }),
    ).toEqual([]);
  });
});

describe('check issue scope path matching', () => {
  it('preserves source owner-relative scope matching', () => {
    const rootDirectory = path.resolve('path filter workspace');
    const ownerDirectory = path.join(rootDirectory, 'packages', 'a');
    const candidates: PathFilterCandidate[] = [
      {
        kind: 'file',
        path: path.join(ownerDirectory, 'src', 'nested', 'file.ts'),
        scopeRelativeTo: [ownerDirectory],
      },
    ];

    expect(
      isPathCandidatesMatchScopeFilters({
        candidates,
        rootDir: rootDirectory,
        scopes: ['src/**'],
      }),
    ).toBe(true);
    expect(
      isPathCandidatesMatchFileFilters({
        candidates,
        files: ['src/nested/file.ts'],
        rootDir: rootDirectory,
      }),
    ).toBe(false);
  });

  it('never treats diagnostic scope labels as path candidates', () => {
    const rootDirectory = path.resolve('path filter workspace');
    const diagnosticScope = 'source.declarations.ambient[0]';
    const issue = createLiminaCheckIssue({
      code: 'LIMINA_SOURCE_AMBIENT_DECLARATION_CONFIG_INVALID',
      locations: [{ label: 'field', scope: diagnosticScope }],
      reason: 'invalid ambient declaration config',
      rootDir: rootDirectory,
      scope: diagnosticScope,
      task: 'source:check',
      title: 'Ambient declaration config is invalid',
    });
    const payload = JSON.parse(
      formatCheckIssueSnapshotInventory({
        filters: { scopes: [diagnosticScope] },
        format: 'json',
        rootDir: rootDirectory,
        snapshot: {
          command: 'limina check',
          createdAt: '2026-07-17T00:00:00.000Z',
          issues: [issue],
          status: 'completed',
          version: 8,
        },
      }),
    ) as { issueCount: number };

    expect(payload.issueCount).toBe(0);
  });
});
