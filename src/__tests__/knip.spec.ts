import type { ResolvedLiminaConfig } from '#config/runner';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import { resolveGovernanceRoot } from '#utils/workspace-root';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectValidatedWorkspaceContext } from '../core/workspace/validated-context';
import {
  collectKnipSourceIssues,
  collectUnusedSourceFileIssues,
  parseKnipJsonReport,
  resolveKnipCliPath,
} from '../source-check/knip';
import { createFixturePathResolver } from './helpers/path';

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
    ).toThrow(/Missing Limina runtime dependency:[\s\S]*package: knip/u);
  });

  it('reports a resolved but missing Knip CLI path as a missing peer dependency', () => {
    const entryPath = path.join(
      tmpdir(),
      'limina-knip-missing',
      'node_modules/knip/dist/index.js',
    );

    expect(() => resolveKnipCliPath(() => entryPath)).toThrow(
      /Missing Limina runtime dependency:[\s\S]*package: knip/u,
    );
  });
});

async function createKnipFixture(files: Record<string, string> = {}) {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-knip-')),
  );
  const fixturePath = createFixturePathResolver(rootDir);
  for (const [file, text] of Object.entries({
    'package.json': '{}',
    ...files,
  })) {
    await mkdir(path.dirname(fixturePath(file)), { recursive: true });
    await writeFile(fixturePath(file), text);
  }
  const configPath = fixturePath('limina.config.mjs');
  const config: ResolvedLiminaConfig = {
    configPath,
    rootDir: fixturePath(),
    governanceRoot: resolveGovernanceRoot(configPath),
  };
  const workspacePackages = await collectRawWorkspacePackages(config);
  const workspaceContext = await collectValidatedWorkspaceContext({
    config,
    rawPackages: workspacePackages,
  });
  return {
    config,
    workspacePackages,
    workspaceContext,
    path: fixturePath,
    cleanup: () => rm(rootDir, { recursive: true, force: true }),
  };
}

describe('collectKnipSourceIssues', () => {
  it('keeps a root manifest changed during Knip analysis intact', async () => {
    const fixture = await createKnipFixture();
    const userManifest = '{"name":"user-root"}\n';
    try {
      await collectKnipSourceIssues({
        ...fixture,
        ignoredKeys: new Set(),
        includeFiles: false,
        ownerProjects: [],
        knipRunner: async (invocation) => {
          expect(invocation.rootDir).toBe(fixture.path());
          await writeFile(fixture.path('package.json'), userManifest);
          return '{"issues":[]}';
        },
      });
      expect(await readFile(fixture.path('package.json'), 'utf8')).toBe(
        userManifest,
      );
      expect(fixture.config.governanceRoot.manifest).toEqual({});
    } finally {
      await fixture.cleanup();
    }
  });

  it('runs real Knip for a nameless single-package root', async () => {
    const fixture = await createKnipFixture({
      'src/index.ts': 'export const value = 1;',
      'src/unused.ts': 'export const unused = true;',
    });
    try {
      const issues = await collectKnipSourceIssues({
        ...fixture,
        analysisGroups: [{ workspaceNames: ['.'] }],
        ignoredKeys: new Set(),
        includeFiles: true,
        ownerProjects: [
          {
            directory: fixture.path(),
            entryFiles: ['src/index.ts'],
            ignoreFiles: [],
            projectFiles: ['src/**/*.ts'],
            virtualEntrySourceFiles: [],
          },
        ],
      });
      expect(issues).toEqual({
        unusedSourceFiles: [
          { externalCode: 'files', filePath: fixture.path('src/unused.ts') },
        ],
        unusedWorkspaceDependencies: [],
      });
      expect(await readFile(fixture.path('package.json'), 'utf8')).toBe('{}');
    } finally {
      await fixture.cleanup();
    }
  });

  it('isolates concurrent analysis configs and cleans them after a failed run', async () => {
    const fixture = await createKnipFixture();
    const configs: string[] = [];
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = (fail: boolean) =>
      collectKnipSourceIssues({
        ...fixture,
        ignoredKeys: new Set(),
        includeFiles: false,
        ownerProjects: [],
        knipRunner: async (invocation) => {
          configs.push(invocation.configPath);
          if (configs.length === 2) release();
          await ready;
          if (fail) throw new Error('controlled Knip failure');
          return '{"issues":[]}';
        },
      });
    try {
      const results = await Promise.allSettled([run(false), run(true)]);
      expect(results.map((result) => result.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect(new Set(configs).size).toBe(2);
      for (const configPath of configs)
        await expect(readFile(configPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      expect(await readFile(fixture.path('package.json'), 'utf8')).toBe('{}');
    } finally {
      await fixture.cleanup();
    }
  });
});
