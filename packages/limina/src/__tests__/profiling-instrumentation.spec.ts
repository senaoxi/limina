import type { ResolvedLiminaConfig } from '#config/runner';
import {
  createImportAnalysisContext,
  type ImportResolveContextFields,
} from '#core/import-analysis/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  createWorkspaceExportsResolutionIndex,
  type WorkspaceExportsResolutionProfile,
} from '../core/workspace/exports';
import {
  type AnalysisMetricAggregate,
  createProfilingMetricsRecorder,
} from '../profiling/metrics';
import { toPortablePath } from './helpers/path';

async function writeText(
  rootDir: string,
  relativePath: string,
  text: string,
): Promise<string> {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
  return filePath;
}

function metricCount(
  snapshot: readonly AnalysisMetricAggregate[],
  name: AnalysisMetricAggregate['name'],
  kind?: string,
): number {
  return snapshot
    .filter(
      (metric) =>
        metric.name === name && (kind === undefined || metric.kind === kind),
    )
    .reduce((total, metric) => total + metric.count, 0);
}

describe('module resolution profiling instrumentation', () => {
  it('keeps outer-index, native TS cache, and Oxc factory counters distinct', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-resolution-metrics-')),
    );

    try {
      const configPath = await writeText(
        rootDir,
        'tsconfig.json',
        JSON.stringify({ compilerOptions: {} }),
      );
      const containingFile = await writeText(
        rootDir,
        'src/index.ts',
        "import './target';\n",
      );
      const targetPath = await writeText(
        rootDir,
        'src/target.ts',
        'export const target = true;\n',
      );
      const metrics = createProfilingMetricsRecorder();
      const context = createImportAnalysisContext({ metrics });
      const compilerOptions: ts.CompilerOptions = {};
      const resolverContext = {
        checkerPresets: ['tsc', 'tsgo'],
        configPath,
        extensions: ['.ts'],
        resolverConfigPath: configPath,
      } satisfies Parameters<typeof context.resolveTypeScriptImport>[3];

      expect(
        context.resolveTypeScriptImport(
          'missing-module',
          containingFile,
          compilerOptions,
          resolverContext,
        ),
      ).toBeNull();
      expect(
        context.resolveOxcImport(
          'missing-module',
          containingFile,
          compilerOptions,
          resolverContext,
        ),
      ).toBeNull();
      expect(
        context.resolveOxcImport(
          'missing-module',
          containingFile,
          compilerOptions,
          resolverContext,
        ),
      ).toBeNull();

      for (let request = 0; request < 2; request += 1) {
        expect(
          context.resolveInternalImport(
            './target',
            containingFile,
            compilerOptions,
            resolverContext,
          ),
        ).toBe(toPortablePath(targetPath));
      }

      const snapshot = metrics.snapshot();
      expect(metricCount(snapshot, 'module-resolution-request')).toBe(5);
      expect(metricCount(snapshot, 'module-resolution-index-miss')).toBe(5);
      expect(metricCount(snapshot, 'module-resolution-index-hit')).toBe(0);
      expect(metricCount(snapshot, 'typescript-resolution')).toBe(1);
      expect(
        metricCount(snapshot, 'typescript-module-resolution-cache-miss'),
      ).toBe(1);
      expect(
        metricCount(snapshot, 'typescript-module-resolution-cache-hit'),
      ).toBe(0);
      expect(metricCount(snapshot, 'oxc-resolution')).toBe(2);
      expect(metricCount(snapshot, 'oxc-resolver-factory-create')).toBe(1);
      expect(metricCount(snapshot, 'oxc-resolver-factory-hit')).toBe(1);

      expect(metricCount(snapshot, 'internal-import-resolution')).toBe(2);
      expect(metricCount(snapshot, 'import-resolution-cache-miss')).toBe(1);
      expect(metricCount(snapshot, 'import-resolution-cache-hit')).toBe(1);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('reuses one native TypeScript cache within a conservative resolver identity', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-ts-cache-metrics-')),
    );

    try {
      const configPath = await writeText(
        rootDir,
        'tsconfig.json',
        JSON.stringify({ compilerOptions: {} }),
      );
      const containingFile = await writeText(
        rootDir,
        'src/index.ts',
        "import './target';\n",
      );
      await writeText(
        rootDir,
        'src/target.ts',
        'export const target = true;\n',
      );
      const metrics = createProfilingMetricsRecorder();
      const context = createImportAnalysisContext({ metrics });
      const compilerOptions: ts.CompilerOptions = {
        moduleResolution: ts.ModuleResolutionKind.Node10,
      };
      const resolverContext = {
        checkerPresets: [],
        configPath,
        extensions: ['.ts'],
        resolverConfigPath: configPath,
      };

      const first = context.resolveTypeScriptImport(
        './target',
        containingFile,
        compilerOptions,
        resolverContext,
      );
      const second = context.resolveTypeScriptImport(
        './target',
        containingFile,
        compilerOptions,
        resolverContext,
      );

      expect(second).toEqual(first);
      const snapshot = metrics.snapshot();
      expect(metricCount(snapshot, 'typescript-resolution')).toBe(2);
      expect(
        metricCount(snapshot, 'typescript-module-resolution-cache-miss'),
      ).toBe(1);
      expect(
        metricCount(snapshot, 'typescript-module-resolution-cache-hit'),
      ).toBe(1);
      expect(metricCount(snapshot, 'module-resolution-request')).toBe(2);
      expect(metricCount(snapshot, 'module-resolution-index-miss')).toBe(2);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('keeps config, compiler option, and extension cache identities separate', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-ts-cache-identity-')),
    );

    try {
      const configPathA = await writeText(
        rootDir,
        'configs/a.json',
        JSON.stringify({ compilerOptions: {} }),
      );
      const configPathB = await writeText(
        rootDir,
        'configs/b.json',
        JSON.stringify({ compilerOptions: {} }),
      );
      const containingFile = await writeText(
        rootDir,
        'src/index.ts',
        "import './target';\n",
      );
      await writeText(
        rootDir,
        'src/target.ts',
        'export const target = true;\n',
      );
      const metrics = createProfilingMetricsRecorder();
      const context = createImportAnalysisContext({ metrics });
      const baseOptions: ts.CompilerOptions = {
        moduleResolution: ts.ModuleResolutionKind.Node10,
      };
      const baseContext = {
        checkerPresets: [],
        configPath: configPathA,
        extensions: ['.ts'],
        resolverConfigPath: configPathA,
      };
      const requests: [ts.CompilerOptions, ImportResolveContextFields][] = [
        [baseOptions, baseContext],
        [
          baseOptions,
          {
            ...baseContext,
            configPath: configPathB,
            resolverConfigPath: configPathB,
          },
        ],
        [{ ...baseOptions, preserveSymlinks: true }, baseContext],
        [baseOptions, { ...baseContext, extensions: ['.ts', '.vue'] }],
        [baseOptions, baseContext],
      ];

      for (const [compilerOptions, resolverContext] of requests) {
        expect(
          context.resolveTypeScriptImport(
            './target',
            containingFile,
            compilerOptions,
            resolverContext,
          )?.resolvedBy,
        ).toBe('typescript');
      }

      const snapshot = metrics.snapshot();
      expect(
        metricCount(snapshot, 'typescript-module-resolution-cache-miss'),
      ).toBe(4);
      expect(
        metricCount(snapshot, 'typescript-module-resolution-cache-hit'),
      ).toBe(1);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('does not share native TypeScript caches across analysis generations', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-ts-cache-generation-')),
    );

    try {
      const configPath = await writeText(
        rootDir,
        'tsconfig.json',
        JSON.stringify({ compilerOptions: {} }),
      );
      const containingFile = await writeText(
        rootDir,
        'src/index.ts',
        "import './target';\n",
      );
      await writeText(
        rootDir,
        'src/target.ts',
        'export const target = true;\n',
      );
      const metrics = createProfilingMetricsRecorder();
      const compilerOptions: ts.CompilerOptions = {};
      const resolverContext = {
        checkerPresets: [],
        configPath,
        extensions: ['.ts'],
        resolverConfigPath: configPath,
      };

      const first = createImportAnalysisContext({ metrics });
      const second = createImportAnalysisContext({ metrics });
      const firstResult = first.resolveTypeScriptImport(
        './target',
        containingFile,
        compilerOptions,
        resolverContext,
      );
      const secondResult = second.resolveTypeScriptImport(
        './target',
        containingFile,
        compilerOptions,
        resolverContext,
      );

      expect(secondResult).toEqual(firstResult);
      const snapshot = metrics.snapshot();
      expect(
        metricCount(snapshot, 'typescript-module-resolution-cache-miss'),
      ).toBe(2);
      expect(
        metricCount(snapshot, 'typescript-module-resolution-cache-hit'),
      ).toBe(0);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('counts every workspace export and original project profile pair', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-export-metrics-')),
    );

    try {
      const configPath = await writeText(
        rootDir,
        'tsconfig.json',
        JSON.stringify({ compilerOptions: {} }),
      );
      const alternateConfigPath = await writeText(
        rootDir,
        'tsconfig.alternate.json',
        JSON.stringify({ compilerOptions: {} }),
      );
      const liminaConfigPath = await writeText(
        rootDir,
        'limina.config.mjs',
        'export default {};\n',
      );
      const packageDirectory = path.join(rootDir, 'packages/pkg');
      const manifest = {
        exports: {
          '.': {
            import: './dist/index.js',
            types: './dist/index.d.ts',
          },
        },
        name: '@fixture/pkg',
      };
      await writeText(
        rootDir,
        'packages/pkg/package.json',
        JSON.stringify(manifest),
      );
      await writeText(
        rootDir,
        'packages/pkg/dist/index.d.ts',
        'export declare const value: true;\n',
      );
      await writeText(
        rootDir,
        'packages/pkg/dist/index.js',
        'export const value = true;\n',
      );

      const config: ResolvedLiminaConfig = {
        configPath: liminaConfigPath,
        rootDir,
      };
      const workspacePackage: WorkspacePackage = {
        directory: packageDirectory,
        manifest,
        name: manifest.name,
      };
      const compilerOptions: ts.CompilerOptions = {};
      const profiles: WorkspaceExportsResolutionProfile[] = [
        'project-a',
        'project-b',
      ].map((projectName) => ({
        checkerPresets: [],
        configPath: path.join(rootDir, projectName, 'tsconfig.json'),
        extensions: ['.ts'],
        options: compilerOptions,
        resolverConfigPath: configPath,
      }));
      const baselineIndex = await createWorkspaceExportsResolutionIndex({
        config,
        importAnalysis: createImportAnalysisContext(),
        packages: [workspacePackage],
        profiles,
      });
      const metrics = createProfilingMetricsRecorder();
      const index = await createWorkspaceExportsResolutionIndex({
        config,
        importAnalysis: createImportAnalysisContext({ metrics }),
        metrics,
        packages: [workspacePackage],
        profiles,
      });

      expect(index.problems).toEqual(baselineIndex.problems);
      for (const profile of profiles) {
        expect(index.get(profile.configPath, manifest.name)).toEqual(
          baselineIndex.get(profile.configPath, manifest.name),
        );
      }

      const snapshot = metrics.snapshot();
      expect(metricCount(snapshot, 'workspace-export-profile-count')).toBe(2);
      expect(
        metricCount(
          snapshot,
          'workspace-export-typescript-semantic-profile-count',
        ),
      ).toBe(2);
      expect(
        metricCount(snapshot, 'workspace-export-oxc-semantic-profile-count'),
      ).toBe(2);
      expect(metricCount(snapshot, 'workspace-export-resolution-request')).toBe(
        2,
      );
      expect(
        metricCount(snapshot, 'workspace-export-typescript-resolution'),
      ).toBe(2);
      expect(metricCount(snapshot, 'workspace-export-oxc-resolution')).toBe(2);
      expect(metricCount(snapshot, 'module-resolution-request')).toBe(4);
      expect(metricCount(snapshot, 'module-resolution-index-miss')).toBe(4);
      expect(metricCount(snapshot, 'typescript-resolution')).toBe(2);
      expect(
        metricCount(snapshot, 'typescript-module-resolution-cache-miss'),
      ).toBe(2);
      expect(metricCount(snapshot, 'oxc-resolution')).toBe(2);
      expect(metricCount(snapshot, 'oxc-resolver-factory-create')).toBe(1);
      expect(metricCount(snapshot, 'oxc-resolver-factory-hit')).toBe(1);

      const distinctMetrics = createProfilingMetricsRecorder();
      const distinctProfiles = [
        profiles[0],
        {
          ...profiles[1],
          resolverConfigPath: alternateConfigPath,
        },
      ];
      const distinctIndex = await createWorkspaceExportsResolutionIndex({
        config,
        importAnalysis: createImportAnalysisContext({
          metrics: distinctMetrics,
        }),
        metrics: distinctMetrics,
        packages: [workspacePackage],
        profiles: distinctProfiles,
      });

      expect(distinctIndex.problems).toEqual(baselineIndex.problems);
      for (const profile of distinctProfiles) {
        expect(distinctIndex.get(profile.configPath, manifest.name)).toEqual(
          baselineIndex.get(profile.configPath, manifest.name),
        );
      }
      const distinctSnapshot = distinctMetrics.snapshot();
      expect(
        metricCount(distinctSnapshot, 'workspace-export-oxc-resolution'),
      ).toBe(2);
      expect(metricCount(distinctSnapshot, 'oxc-resolver-factory-create')).toBe(
        2,
      );
      expect(metricCount(distinctSnapshot, 'oxc-resolver-factory-hit')).toBe(0);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});
