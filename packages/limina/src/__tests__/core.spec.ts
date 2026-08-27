import type { ResolvedLiminaConfig } from '#config/runner';
import { type AnalysisProviderSet, createAnalysisProviders } from '#core';
import { existsSync, readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPipeline } from '../pipeline/runner';
import { LiminaPreflightManager } from '../preflight';
import { createProfilingMetricsRecorder } from '../profiling/metrics';
import { collectCoverage } from '../proof/coverage-collection';
import { createSourceCheckState } from '../source-check/run-state';
import { toPortablePath, toPortablePaths } from './helpers/path';

const requireFromTest = createRequire(import.meta.url);

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

async function linkInstalledPackage(options: {
  installedName: string;
  packageName: string;
  rootDir: string;
}): Promise<void> {
  const readPackageName = (manifestPath: string): string | undefined => {
    try {
      return (
        JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
      ).name;
    } catch {
      return undefined;
    }
  };
  let packageRoot: string | undefined;
  try {
    const manifestPath = requireFromTest.resolve(
      `${options.installedName}/package.json`,
    );
    if (readPackageName(manifestPath) === options.packageName) {
      packageRoot = path.dirname(manifestPath);
    }
  } catch {
    // Some supported checker packages hide package.json behind exports.
  }
  let directory = path.dirname(requireFromTest.resolve(options.installedName));
  while (packageRoot === undefined) {
    if (
      readPackageName(path.join(directory, 'package.json')) ===
      options.packageName
    ) {
      packageRoot = directory;
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(
        `Unable to find ${options.packageName} for ${options.installedName}.`,
      );
    }
    directory = parent;
  }
  const segments = options.packageName.split('/');
  const packageBaseName = segments.pop()!;
  const nodeModulesDir = path.join(
    options.rootDir,
    'node_modules',
    ...segments,
  );
  await mkdir(nodeModulesDir, { recursive: true });
  await symlink(
    packageRoot,
    path.join(nodeModulesDir, packageBaseName),
    'junction',
  );
}

async function linkFrameworkToolchains(packageRootDir: string): Promise<void> {
  await Promise.all([
    linkInstalledPackage({
      installedName: '@astrojs/check',
      packageName: '@astrojs/check',
      rootDir: packageRootDir,
    }),
    linkInstalledPackage({
      installedName: 'astro-v7-current',
      packageName: 'astro',
      rootDir: packageRootDir,
    }),
    linkInstalledPackage({
      installedName: 'svelte-v4-min',
      packageName: 'svelte',
      rootDir: packageRootDir,
    }),
    linkInstalledPackage({
      installedName: 'svelte2tsx',
      packageName: 'svelte2tsx',
      rootDir: packageRootDir,
    }),
    linkInstalledPackage({
      installedName: 'typescript',
      packageName: 'typescript',
      rootDir: packageRootDir,
    }),
  ]);
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
        tsc: {
          include: ['packages/a/tsconfig.json'],
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
      dependencies: {
        '@astrojs/check': '0.9.10',
        astro: '7.2.0',
        svelte: '4.0.0',
        typescript: '6.0.3',
      },
      name: '@fixture/a',
      version: '1.0.0',
    }),
  );
  await linkFrameworkToolchains(path.join(rootDir, 'packages/a'));
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

  it.each(['astro', 'svelte'] as const)(
    'governs pure .%s sources across ownership, graph, proof, and package domains',
    async (family) => {
      const fixture = await createCoreFixture();
      const sourceConfigPath = path.join(
        fixture.rootDir,
        'packages/a/tsconfig.lib.json',
      );
      const sourceFilePath = path.join(
        fixture.rootDir,
        `packages/a/src/App.${family}`,
      );
      fixture.config.config = {
        ...fixture.config.config,
        checkers: {
          [family === 'astro' ? 'astro' : 'svelte-check']: {
            include: ['packages/a/tsconfig.json'],
          },
        },
        source: { include: [`**/*.${family}`] },
      };
      await writeText(
        sourceConfigPath,
        stringifyJson({
          compilerOptions: buildCompilerOptions,
          include: [`src/**/*.${family}`],
          liminaOptions: { graphRules: ['framework'] },
        }),
      );
      await writeText(sourceFilePath, '<h1>Framework source</h1>\n');

      try {
        const graph = await fixture.core.buildGraph.getGraph();
        const checkerName = family === 'astro' ? 'astro' : 'svelte-check';
        const unit = graph.governedSources
          .get(checkerName)
          ?.get(sourceConfigPath);
        const projection = unit?.buildProjection;
        const projectedConfigPath =
          projection === undefined
            ? sourceConfigPath
            : 'buildConfigPath' in projection
              ? projection.buildConfigPath
              : projection.kind === 'framework-checker'
                ? sourceConfigPath
                : projection.dtsConfigPath;
        const sourceGraph =
          await fixture.core.tsconfig.getSourceGraphProjects();
        const sourceProject = sourceGraph.projects.find(
          (project) => project.configPath === projectedConfigPath,
        );
        const owner =
          await fixture.core.tsconfig.findOwningProject(sourceFilePath);
        const preflight = new LiminaPreflightManager({
          config: fixture.config,
          providers: fixture.core,
        });
        const sourceState = await createSourceCheckState(fixture.config, {
          preflight,
        });
        const coverage = collectCoverage({
          checkerTargets: [],
          config: fixture.config,
          generatedGraph: graph,
          graphRoutes: [],
          sourceFiles: new Set([sourceFilePath]),
          virtualFiles: graph.generatedFiles,
        });
        const domain =
          await fixture.core.packages.getPackageDomain('@fixture/a');

        expect(unit?.ownedFileNames).toEqual([sourceFilePath]);
        expect(sourceProject?.ownedFileNames).toEqual([sourceFilePath]);
        expect(sourceProject?.labels).toEqual(['framework']);
        expect(owner?.resolverConfigPath).toBe(sourceConfigPath);
        expect(
          sourceState.sourceProjectEntries.find(
            (entry) => entry.project.configPath === projectedConfigPath,
          )?.fileNames,
        ).toEqual([sourceFilePath]);
        expect(coverage.get(sourceFilePath)).toMatchObject([
          {
            checkerName,
            projectPath: sourceConfigPath,
            type: 'graph',
          },
        ]);
        expect(domain.sourceConfigPaths).toContain(sourceConfigPath);
        expect(domain.sourceModulePaths).toContain(sourceFilePath);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('shares one workspace path and lookup index within a provider generation', async () => {
    const fixture = await createCoreFixture();
    const metrics = createProfilingMetricsRecorder();
    const core = createAnalysisProviders(fixture.config, undefined, metrics);
    const filePath = path.join(fixture.rootDir, 'packages/a/src/index.ts');

    try {
      await core.buildGraph.getGraph();
      const pathIndex = await core.workspace.getPathIndex();
      const lookupIndex = await core.workspace.getLookupIndex();
      expect(await core.workspace.getPathIndex()).toBe(pathIndex);
      expect(await core.workspace.getLookupIndex()).toBe(lookupIndex);
      await expect(core.packages.findOwner(filePath)).resolves.toMatchObject({
        name: '@fixture/a',
      });

      const preflight = new LiminaPreflightManager({
        config: fixture.config,
        metrics,
        providers: core,
      });
      expect(await preflight.ensureWorkspaceLookupIndex()).toBe(lookupIndex);
      expect(await preflight.ensureWorkspacePathIndex()).toBe(pathIndex);

      const snapshot = metrics.snapshot();
      const metricCount = (name: string, kind: string): number | undefined =>
        snapshot.find((metric) => metric.name === name && metric.kind === kind)
          ?.count;
      expect(metricCount('provider-cache-miss', 'workspace-path-index')).toBe(
        1,
      );
      expect(metricCount('provider-cache-miss', 'workspace-lookup-index')).toBe(
        1,
      );
      expect(
        metricCount('provider-cache-hit', 'workspace-path-index'),
      ).toBeGreaterThan(0);
      expect(
        metricCount('provider-cache-hit', 'workspace-lookup-index'),
      ).toBeGreaterThan(0);

      const nextGeneration = createAnalysisProviders(fixture.config);
      expect(await nextGeneration.workspace.getPathIndex()).not.toBe(pathIndex);
      expect(await nextGeneration.workspace.getLookupIndex()).not.toBe(
        lookupIndex,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('starts a new analysis generation after external commands', async () => {
    const fixture = await createCoreFixture();
    const preflight = new LiminaPreflightManager({
      config: fixture.config,
    });
    const initialProviders = preflight.providers;
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
        }),
      ).resolves.toBe(true);
      expect(preflight.run.generation).toBe('1');
      expect(preflight.run.id).not.toBe(initialRunId);
      expect(preflight.providers).not.toBe(initialProviders);
    } finally {
      await fixture.cleanup();
    }
  });
});
