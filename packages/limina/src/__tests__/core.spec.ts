import type { ResolvedLiminaConfig } from '#config/runner';
import { type AnalysisProviderSet, createAnalysisProviders } from '#core';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPipeline } from '../pipeline/runner';
import { LiminaPreflightManager } from '../preflight';
import { toPortablePath, toPortablePaths } from './helpers/path';

const buildCompilerOptions = {
  composite: true,
  declaration: true,
  emitDeclarationOnly: true,
  incremental: true,
  module: 'ESNext',
  moduleResolution: 'bundler',
  noEmit: false,
  outDir: './.tsbuild',
  resolveJsonModule: true,
  strict: true,
  target: 'ES2023',
  types: [],
};

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function createCoreFixture(): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  core: AnalysisProviderSet;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-core-')),
  );
  const config: ResolvedLiminaConfig = {
    config: {
      checkers: {
        typescript: {
          include: ['packages/a/tsconfig.json'],
          preset: 'tsc',
        },
      },
    },
    configPath: path.join(rootDir, 'limina.config.mjs'),
    rootDir,
  };

  await writeText(config.configPath, 'export default {};\n');
  await writeText(
    path.join(rootDir, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\n",
  );
  await writeText(
    path.join(rootDir, 'package.json'),
    stringifyJson({
      name: 'fixture',
      private: true,
    }),
  );
  await writeText(
    path.join(rootDir, 'packages/a/package.json'),
    stringifyJson({
      name: '@fixture/a',
      version: '1.0.0',
    }),
  );
  await writeText(
    path.join(rootDir, 'packages/a/tsconfig.json'),
    stringifyJson({
      files: [],
      references: [{ path: './tsconfig.lib.json' }],
    }),
  );
  await writeText(
    path.join(rootDir, 'packages/a/tsconfig.lib.json'),
    stringifyJson({
      compilerOptions: buildCompilerOptions,
      include: ['src/**/*.ts'],
    }),
  );
  await writeText(
    path.join(rootDir, 'packages/a/src/index.ts'),
    "import './dep';\nexport const value = 1;\n",
  );
  await writeText(
    path.join(rootDir, 'packages/a/src/dep.ts'),
    'export const dep = 1;\n',
  );

  return {
    cleanup: async () => {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    },
    config,
    core: createAnalysisProviders(config),
    rootDir,
  };
}

describe('AnalysisProviderSet', () => {
  it('keeps graph analysis read-only until explicit preparation', async () => {
    const fixture = await createCoreFixture();
    const generatedDirectory = path.join(fixture.rootDir, '.limina');

    try {
      const analysis = await fixture.core.buildGraph.getGraph();

      expect(analysis.changed).toBe(true);
      expect(existsSync(generatedDirectory)).toBe(false);

      await new LiminaPreflightManager({
        config: fixture.config,
        providers: fixture.core,
      }).ensureGeneratedArtifactsMaterialized();
      expect(existsSync(generatedDirectory)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('scopes import records to a provider generation', async () => {
    const fixture = await createCoreFixture();
    const filePath = path.join(fixture.rootDir, 'packages/a/src/index.ts');

    try {
      expect(
        fixture.core.imports
          .getImports(filePath)
          .map((record) => record.specifier),
      ).toEqual(['./dep']);

      await writeText(filePath, "import './other';\nexport const value = 2;\n");
      await writeText(
        path.join(fixture.rootDir, 'packages/a/src/other.ts'),
        'export const other = 1;\n',
      );

      expect(
        fixture.core.imports
          .getImports(filePath)
          .map((record) => record.specifier),
      ).toEqual(['./dep']);

      const nextGeneration = createAnalysisProviders(fixture.config);

      expect(
        nextGeneration.imports
          .getImports(filePath)
          .map((record) => record.specifier),
      ).toEqual(['./other']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('resolves imports and project model through core services', async () => {
    const fixture = await createCoreFixture();
    const projectPath = path.join(
      fixture.rootDir,
      'packages/a/tsconfig.lib.json',
    );
    const filePath = path.join(fixture.rootDir, 'packages/a/src/index.ts');

    try {
      const project = await fixture.core.tsconfig.getProject(projectPath);

      expect(toPortablePath(project.configPath)).toBe(
        toPortablePath(projectPath),
      );
      expect(toPortablePaths(project.fileNames)).toContain(
        toPortablePath(filePath),
      );
      expect(toPortablePaths(project.ownedFileNames)).toContain(
        toPortablePath(filePath),
      );
      expect(toPortablePath(project.resolverConfigPath)).toBe(
        toPortablePath(projectPath),
      );
      expect(
        toPortablePath(
          fixture.core.imports.resolveImport({
            containingFile: filePath,
            project,
            specifier: './dep',
          }) ?? '',
        ),
      ).toBe(
        toPortablePath(path.join(fixture.rootDir, 'packages/a/src/dep.ts')),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('builds package domains from generated graph data', async () => {
    const fixture = await createCoreFixture();

    try {
      const domain = await fixture.core.packages.getPackageDomain('@fixture/a');

      expect(domain.package.name).toBe('@fixture/a');
      expect(toPortablePaths(domain.sourceConfigPaths)).toContain(
        toPortablePath(
          path.join(fixture.rootDir, 'packages/a/tsconfig.lib.json'),
        ),
      );
      expect(toPortablePaths(domain.sourceModulePaths)).toContain(
        toPortablePath(path.join(fixture.rootDir, 'packages/a/src/index.ts')),
      );
    } finally {
      await fixture.cleanup();
    }
  });
  it('starts a new analysis generation after external commands', async () => {
    const fixture = await createCoreFixture();
    const core = fixture.core;
    const preflight = new LiminaPreflightManager({
      config: fixture.config,
      providers: core,
    });
    const initialRunId = preflight.run.id;
    fixture.config.pipelines = {
      demo: [
        {
          args: ['-e', 'process.exit(0)'],
          command: process.execPath,
          type: 'command',
        },
      ],
    };

    try {
      await expect(
        runPipeline(fixture.config, 'demo', {
          preflight,
          providers: core,
        }),
      ).resolves.toBe(true);
      expect(preflight.run.generation).toBe('1');
      expect(preflight.run.id).not.toBe(initialRunId);
      expect(preflight.providers).not.toBe(core);
    } finally {
      await fixture.cleanup();
    }
  });
});
