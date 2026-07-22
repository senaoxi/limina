import type { ResolvedLiminaConfig } from '#config/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import { normalizeAbsolutePath } from '#utils/path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectKnipSourceIssues,
  collectUnusedSourceFileIssues,
  parseKnipJsonReport,
  resolveKnipCliPath,
} from '../source-check/knip';

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
        externalCode: 'files',
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
        externalCode: 'files',
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

describe('collectKnipSourceIssues', () => {
  it('does not delete a root manifest created while Knip analysis is running', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-knip-root-'));
    const packageJsonPath = path.join(rootDir, 'package.json');
    const userManifest = '{"name":"user-root"}\n';

    try {
      await collectKnipSourceIssues({
        config: { rootDir } as ResolvedLiminaConfig,
        ignoredKeys: new Set(),
        includeFiles: false,
        knipRunner: async (invocation) => {
          expect(invocation.rootDir).not.toBe(rootDir);
          expect(
            JSON.parse(
              await readFile(
                path.join(invocation.rootDir, 'package.json'),
                'utf8',
              ),
            ),
          ).toEqual({ private: true });
          await writeFile(packageJsonPath, userManifest);
          return '{"issues":[]}';
        },
        ownerProjects: [],
        workspacePackages: [],
      });

      expect(await readFile(packageJsonPath, 'utf8')).toBe(userManifest);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('runs real Knip for a rootless workspace without creating a root manifest', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-knip-rootless-'));
    const packageDir = path.join(rootDir, 'packages/app');
    const packageJsonPath = path.join(rootDir, 'package.json');

    try {
      await mkdir(path.join(packageDir, 'src'), { recursive: true });
      await writeFile(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      await writeFile(
        path.join(packageDir, 'package.json'),
        '{"name":"@fixture/app","private":true,"type":"module"}\n',
      );
      await writeFile(
        path.join(packageDir, 'src/index.ts'),
        'export const value = 1;\n',
      );
      await writeFile(
        path.join(packageDir, 'src/unused.ts'),
        'export const unused = true;\n',
      );

      const issues = await collectKnipSourceIssues({
        config: { rootDir } as ResolvedLiminaConfig,
        ignoredKeys: new Set(),
        includeFiles: true,
        ownerProjects: [
          {
            directory: packageDir,
            entryFiles: ['src/index.ts'],
            ignoreFiles: [],
            projectFiles: ['src/**/*.ts'],
            virtualEntrySourceFiles: [],
          },
        ],
        workspacePackages: [
          {
            directory: packageDir,
            name: '@fixture/app',
          } as WorkspacePackage,
        ],
      });

      expect(issues).toEqual({
        unusedSourceFiles: [
          {
            externalCode: 'files',
            filePath: normalizeAbsolutePath(
              path.join(packageDir, 'src/unused.ts'),
            ),
          },
        ],
        unusedWorkspaceDependencies: [],
      });
      await expect(readFile(packageJsonPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('isolates concurrent rootless analyses and cleans failed shadow roots', async () => {
    const rootDir = await mkdtemp(
      path.join(tmpdir(), 'limina-knip-concurrent-'),
    );
    const analysisRoots: string[] = [];
    let releaseBothAnalyses: (() => void) | undefined;
    const bothAnalysesStarted = new Promise<void>((resolve) => {
      releaseBothAnalyses = resolve;
    });
    const runAnalysis = (fail: boolean) =>
      collectKnipSourceIssues({
        config: { rootDir } as ResolvedLiminaConfig,
        ignoredKeys: new Set(),
        includeFiles: false,
        knipRunner: async (invocation) => {
          analysisRoots.push(invocation.rootDir);
          if (analysisRoots.length === 2) {
            releaseBothAnalyses?.();
          }
          await bothAnalysesStarted;
          if (fail) {
            throw new Error('controlled Knip failure');
          }
          return '{"issues":[]}';
        },
        ownerProjects: [],
        workspacePackages: [],
      });

    try {
      const results = await Promise.allSettled([
        runAnalysis(false),
        runAnalysis(true),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect(new Set(analysisRoots).size).toBe(2);
      for (const analysisRoot of analysisRoots) {
        await expect(
          readFile(path.join(analysisRoot, 'package.json'), 'utf8'),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await expect(
        readFile(path.join(rootDir, 'package.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});
