import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedLiminaConfig } from '../config/runner';
import {
  compileWorkspaceExportResolutionGroups,
  createTypeScriptResolutionSemanticsAdapter,
  getWorkspaceExportSelfNameContext,
  type WorkspaceExportSelfNameEntry,
} from '../core/workspace/export-resolution-profiles';
import {
  createWorkspaceExportsResolutionIndex,
  type WorkspaceExportsMetricsRecorder,
  type WorkspaceExportsResolutionProfile,
} from '../core/workspace/exports';
import { toPortablePath } from './helpers/path';

const fixtureRoot = path.resolve('workspace-export-profile-fixture');

function createProfile(
  name: string,
  options: ts.CompilerOptions = {},
  overrides: Partial<WorkspaceExportsResolutionProfile> = {},
): WorkspaceExportsResolutionProfile {
  return {
    checkerPresets: ['tsc'],
    configPath: path.join(fixtureRoot, name, 'tsconfig.json'),
    extensions: ['.ts', '.tsx'],
    options,
    resolverConfigPath: path.join(
      fixtureRoot,
      'resolver-configs',
      'tsconfig.json',
    ),
    ...overrides,
  };
}

function createSelfNameEntry(
  overrides: Partial<WorkspaceExportSelfNameEntry> = {},
): WorkspaceExportSelfNameEntry {
  const packageDirectory = path.join(fixtureRoot, 'packages/pkg');

  return {
    hasExplicitExports: true,
    isNamedWorkspacePackage: true,
    packageDirectory,
    packageJsonPath: path.join(packageDirectory, 'package.json'),
    packageName: '@fixture/pkg',
    specifier: '@fixture/pkg',
    subpath: '.',
    ...overrides,
  };
}

function createVisiblePackageSystem(options: {
  entry: WorkspaceExportSelfNameEntry;
  manifest?: Record<string, unknown>;
}): Pick<ts.System, 'fileExists' | 'readFile'> {
  const manifest = options.manifest ?? {
    exports: './dist/index.js',
    name: options.entry.packageName,
  };
  const packageJsonPath = toPortablePath(options.entry.packageJsonPath);

  return {
    fileExists: (filePath) => toPortablePath(filePath) === packageJsonPath,
    readFile: (filePath) =>
      toPortablePath(filePath) === packageJsonPath
        ? JSON.stringify(manifest)
        : undefined,
  };
}

describe('workspace-export TypeScript profile compilation', () => {
  it('groups equal cross-config semantics and keeps Oxc on exact factory identity', () => {
    const profiles = [createProfile('a'), createProfile('b')];
    const groups = compileWorkspaceExportResolutionGroups(profiles);

    expect(groups.typescriptGroups.size).toBe(1);
    expect(groups.oxcGroups.size).toBe(1);
    expect(groups.compiledOriginals[0]?.typescriptProfileId).toBe(
      groups.compiledOriginals[1]?.typescriptProfileId,
    );

    const distinctOxcGroups = compileWorkspaceExportResolutionGroups([
      profiles[0]!,
      createProfile(
        'b',
        {},
        {
          resolverConfigPath: path.join(
            fixtureRoot,
            'resolver-configs',
            'alternate.json',
          ),
        },
      ),
    ]);

    expect(distinctOxcGroups.typescriptGroups.size).toBe(1);
    expect(distinctOxcGroups.oxcGroups.size).toBe(2);
  });

  it('normalizes only set-like fields and preserves ordered resolver inputs', () => {
    const common = {
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    } satisfies ts.CompilerOptions;
    const normalizedConditions = compileWorkspaceExportResolutionGroups([
      createProfile('a', {
        ...common,
        customConditions: ['development', 'browser', 'development'],
      }),
      createProfile('b', {
        ...common,
        customConditions: ['browser', 'development'],
      }),
    ]);

    expect(normalizedConditions.typescriptGroups.size).toBe(1);
    expect(normalizedConditions.oxcGroups.size).toBe(2);

    const orderedPaths = compileWorkspaceExportResolutionGroups([
      createProfile('a', {
        ...common,
        paths: {
          '@fixture/*': ['first/*', 'second/*'],
        },
        pathsBasePath: fixtureRoot,
      } as ts.CompilerOptions),
      createProfile('b', {
        ...common,
        paths: {
          '@fixture/*': ['second/*', 'first/*'],
        },
        pathsBasePath: fixtureRoot,
      } as ts.CompilerOptions),
    ]);

    expect(orderedPaths.typescriptGroups.size).toBe(2);

    const normalizedExtensions = compileWorkspaceExportResolutionGroups([
      createProfile('a', common, { extensions: ['.ts', '.vue'] }),
      createProfile('b', common, { extensions: ['.vue', '.ts'] }),
    ]);

    expect(normalizedExtensions.typescriptGroups.size).toBe(1);
  });

  it.each([
    ['allowJs', { allowJs: false }, { allowJs: true }],
    [
      'moduleResolution',
      { moduleResolution: ts.ModuleResolutionKind.Node16 },
      { moduleResolution: ts.ModuleResolutionKind.NodeNext },
    ],
    [
      'resolveJsonModule',
      { resolveJsonModule: false },
      { resolveJsonModule: true },
    ],
    [
      'resolvePackageJsonExports',
      {
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        resolvePackageJsonExports: false,
      },
      {
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        resolvePackageJsonExports: true,
      },
    ],
    [
      'preserveSymlinks',
      { preserveSymlinks: false },
      { preserveSymlinks: true },
    ],
    ['noDtsResolution', { noDtsResolution: false }, { noDtsResolution: true }],
    [
      'moduleSuffixes',
      { moduleSuffixes: ['.native', '.ios'] },
      { moduleSuffixes: ['.ios', '.native'] },
    ],
  ] satisfies readonly (readonly [
    string,
    ts.CompilerOptions,
    ts.CompilerOptions,
  ])[])(
    'partitions native TypeScript semantics for %s',
    (_name, left, right) => {
      const groups = compileWorkspaceExportResolutionGroups([
        createProfile('a', left),
        createProfile('b', right),
      ]);

      expect(groups.typescriptGroups.size).toBe(2);
    },
  );

  it('preserves paths pattern order and uses the effective absolute paths base', () => {
    const sharedPathsBase = path.join(fixtureRoot, 'shared-paths-base');
    const equivalent = compileWorkspaceExportResolutionGroups([
      createProfile('a', {
        paths: { '@fixture/*': ['src/*'] },
        pathsBasePath: sharedPathsBase,
      } as ts.CompilerOptions),
      createProfile('b', {
        paths: { '@fixture/*': ['src/*'] },
        pathsBasePath: sharedPathsBase,
      } as ts.CompilerOptions),
    ]);

    expect(equivalent.typescriptGroups.size).toBe(1);

    const orderedPatterns = compileWorkspaceExportResolutionGroups([
      createProfile('ordered-a', {
        paths: {
          '@first/*': ['first/*'],
          '@second/*': ['second/*'],
        },
        pathsBasePath: sharedPathsBase,
      } as ts.CompilerOptions),
      createProfile('ordered-b', {
        paths: {
          '@second/*': ['second/*'],
          '@first/*': ['first/*'],
        },
        pathsBasePath: sharedPathsBase,
      } as ts.CompilerOptions),
    ]);

    expect(orderedPatterns.typescriptGroups.size).toBe(2);
  });

  it('partitions every Oxc factory-identity dimension conservatively', () => {
    const extensionGroups = compileWorkspaceExportResolutionGroups([
      createProfile('extension-a', {}, { extensions: ['.ts'] }),
      createProfile('extension-b', {}, { extensions: ['.ts', '.vue'] }),
    ]);
    const symlinkGroups = compileWorkspaceExportResolutionGroups([
      createProfile('symlink-a', { preserveSymlinks: false }),
      createProfile('symlink-b', { preserveSymlinks: true }),
    ]);
    const exportsModeGroups = compileWorkspaceExportResolutionGroups([
      createProfile('mode-a', {
        moduleResolution: ts.ModuleResolutionKind.Node10,
      }),
      createProfile('mode-b', {
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      }),
    ]);

    expect(extensionGroups.oxcGroups.size).toBe(2);
    expect(symlinkGroups.oxcGroups.size).toBe(2);
    expect(exportsModeGroups.oxcGroups.size).toBe(2);
  });

  it('absolutizes config-relative bases and partitions distinct directories', () => {
    const groups = compileWorkspaceExportResolutionGroups([
      createProfile('a', { baseUrl: './src' }),
      createProfile('b', { baseUrl: './src' }),
    ]);

    expect(groups.typescriptGroups.size).toBe(2);
  });

  it('omits modern typeRoots but retains their order for Classic and Node10', () => {
    const modern = compileWorkspaceExportResolutionGroups([
      createProfile('modern-a', {
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        typeRoots: [path.join(fixtureRoot, 'types-a')],
      }),
      createProfile('modern-b', {
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        typeRoots: [path.join(fixtureRoot, 'types-b')],
      }),
    ]);

    expect(modern.typescriptGroups.size).toBe(1);

    for (const moduleResolution of [
      ts.ModuleResolutionKind.Classic,
      ts.ModuleResolutionKind.Node10,
    ]) {
      const legacy = compileWorkspaceExportResolutionGroups([
        createProfile(`legacy-${moduleResolution}-a`, {
          moduleResolution,
          typeRoots: [path.join(fixtureRoot, 'types-a')],
        }),
        createProfile(`legacy-${moduleResolution}-b`, {
          moduleResolution,
          typeRoots: [path.join(fixtureRoot, 'types-b')],
        }),
      ]);

      expect(legacy.typescriptGroups.size).toBe(2);
    }
  });

  it('keeps confirmed irrelevant options out of the semantic identity', () => {
    const groups = compileWorkspaceExportResolutionGroups([
      createProfile('a', {
        allowArbitraryExtensions: false,
        rootDirs: [path.join(fixtureRoot, 'root-a')],
      }),
      createProfile('b', {
        allowArbitraryExtensions: true,
        rootDirs: [path.join(fixtureRoot, 'root-b')],
      }),
    ]);

    expect(groups.typescriptGroups.size).toBe(1);
  });

  it('uses a fallback-only group when no checker adapter is active', () => {
    const groups = compileWorkspaceExportResolutionGroups([
      createProfile('a', {}, { checkerPresets: ['unknown-checker' as never] }),
      createProfile('b', {}, { checkerPresets: ['unknown-checker' as never] }),
    ]);

    expect(groups.typescriptGroups.size).toBe(1);
    expect([...groups.typescriptGroups.values()][0]?.key[0]).toBe(
      'fallback-only-v1',
    );
  });

  it('records audited-adapter fallback details and always makes them singleton', () => {
    const unsupported = compileWorkspaceExportResolutionGroups(
      [createProfile('a'), createProfile('b')],
      {
        typeScriptAdapter: createTypeScriptResolutionSemanticsAdapter({
          version: '6.0.4',
        }),
      },
    );

    expect(unsupported.typescriptGroups.size).toBe(2);
    expect(
      unsupported.compiledOriginals.map(
        (profile) => profile.typescriptFallbackReason,
      ),
    ).toEqual([
      {
        actualVersion: '6.0.4',
        kind: 'unsupported-runtime-version',
      },
      {
        actualVersion: '6.0.4',
        kind: 'unsupported-runtime-version',
      },
    ]);

    const missingHelper = compileWorkspaceExportResolutionGroups(
      [createProfile('missing-helper')],
      {
        typeScriptAdapter: createTypeScriptResolutionSemanticsAdapter({
          getAllowJSCompilerOption: () => false,
          getEmitModuleResolutionKind: () => ts.ModuleResolutionKind.NodeNext,
          getResolveJsonModule: () => true,
          version: '6.0.3',
        }),
      },
    );

    expect(
      missingHelper.compiledOriginals[0]?.typescriptFallbackReason,
    ).toEqual({
      helpers: ['getResolvePackageJsonExports'],
      kind: 'missing-runtime-helper',
    });

    const unclassified = compileWorkspaceExportResolutionGroups([
      createProfile('unclassified', {
        futureResolutionOption: true,
      } as ts.CompilerOptions),
    ]);

    expect(unclassified.compiledOriginals[0]?.typescriptFallbackReason).toEqual(
      {
        kind: 'unclassified-compiler-option',
        optionNames: ['futureResolutionOption'],
      },
    );

    const unresolvedPath = compileWorkspaceExportResolutionGroups([
      createProfile(
        'unresolved-path',
        { baseUrl: './src' },
        {
          configPath: 'relative/tsconfig.json',
        },
      ),
    ]);

    expect(
      unresolvedPath.compiledOriginals[0]?.typescriptFallbackReason,
    ).toEqual({
      kind: 'unresolved-config-relative-path',
      optionNames: ['baseUrl'],
    });
  });
});

describe('workspace-export self-name eligibility', () => {
  it('accepts the exact package root and slash-delimited export subpaths', () => {
    const rootEntry = createSelfNameEntry();
    const subpathEntry = createSelfNameEntry({
      specifier: '@fixture/pkg/feature',
      subpath: './feature',
    });

    expect(
      getWorkspaceExportSelfNameContext({
        entry: rootEntry,
        system: createVisiblePackageSystem({ entry: rootEntry }),
      }),
    ).toMatchObject({ eligible: true, failureReason: null });
    expect(
      getWorkspaceExportSelfNameContext({
        entry: subpathEntry,
        system: createVisiblePackageSystem({ entry: subpathEntry }),
      }),
    ).toMatchObject({ eligible: true, failureReason: null });
  });

  it.each<
    [
      string,
      Partial<WorkspaceExportSelfNameEntry>,
      { manifest?: Record<string, unknown>; unavailable?: boolean } | undefined,
    ]
  >([
    [
      'not-a-named-workspace-package',
      { isNamedWorkspacePackage: false },
      undefined,
    ],
    ['missing-exports', { hasExplicitExports: false }, undefined],
    [
      'containing-file-mismatch',
      { packageJsonPath: path.join(fixtureRoot, 'other/package.json') },
      undefined,
    ],
    [
      'specifier-is-not-self-name',
      { specifier: '@fixture/pkg-other' },
      undefined,
    ],
    ['missing-exports', {}, { manifest: { name: '@fixture/pkg' } }],
    [
      'package-scope-unavailable',
      {},
      {
        manifest: {
          exports: './dist/index.js',
          name: '@fixture/different-package',
        },
      },
    ],
    ['package-scope-unavailable', {}, { unavailable: true }],
  ] as const)(
    'falls back for %s',
    (failureReason, entryOverrides, systemOptions) => {
      const entry = createSelfNameEntry(entryOverrides);
      const system: Pick<ts.System, 'fileExists' | 'readFile'> =
        systemOptions?.unavailable
          ? {
              fileExists: () => false,
              readFile: () => {},
            }
          : createVisiblePackageSystem({
              entry,
              manifest: systemOptions?.manifest,
            });

      expect(
        getWorkspaceExportSelfNameContext({ entry, system }),
      ).toMatchObject({
        eligible: false,
        failureReason,
      });
    },
  );
});

describe('workspace-export grouped execution', () => {
  it('keeps logical metrics in expansion and creates fresh per-original results', async () => {
    const rootDir = await mkdtemp(
      path.join(tmpdir(), 'limina-export-profile-grouping-'),
    );
    const packageDirectory = path.join(rootDir, 'packages/pkg');
    const manifest = {
      exports: './dist/index.js',
      name: '@fixture/pkg',
    };

    try {
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        path.join(packageDirectory, 'package.json'),
        JSON.stringify(manifest),
      );
      const profiles = [
        createProfile(
          'a',
          {},
          {
            configPath: path.join(rootDir, 'a/tsconfig.json'),
            resolverConfigPath: path.join(rootDir, 'tsconfig.json'),
          },
        ),
        createProfile(
          'b',
          {},
          {
            configPath: path.join(rootDir, 'b/tsconfig.json'),
            resolverConfigPath: path.join(rootDir, 'tsconfig.json'),
          },
        ),
      ];
      const typeScriptResolver = vi.fn(() => ({
        resolvedFileName: path.join(packageDirectory, 'dist/index.d.ts'),
      }));
      const oxcResolver = vi.fn(() =>
        path.join(packageDirectory, 'dist/index.js'),
      );
      const clearOxcResolverCaches = vi.fn();
      const importAnalysis = {
        clearOxcResolverCaches,
        resolveOxcImport: oxcResolver,
        resolveTypeScriptImport: typeScriptResolver,
      } as unknown as ImportAnalysisContext;
      const metricEvents: string[] = [];
      const metrics = {
        record: (measurement: { readonly name: string }) => {
          metricEvents.push(measurement.name);
        },
      } as WorkspaceExportsMetricsRecorder;
      const config = {
        configPath: path.join(rootDir, 'limina.config.mjs'),
        rootDir,
      } as ResolvedLiminaConfig;
      const workspacePackage = {
        directory: packageDirectory,
        manifest,
        name: manifest.name,
      } satisfies WorkspacePackage;
      const index = await createWorkspaceExportsResolutionIndex({
        config,
        importAnalysis,
        metrics,
        packages: [workspacePackage],
        profiles,
      });

      expect(typeScriptResolver).toHaveBeenCalledTimes(1);
      expect(oxcResolver).toHaveBeenCalledTimes(1);
      expect(clearOxcResolverCaches).toHaveBeenCalledTimes(1);
      expect(metricEvents).toEqual([
        'workspace-export-profile-count',
        'workspace-export-typescript-semantic-profile-count',
        'workspace-export-oxc-semantic-profile-count',
        'workspace-export-grouped-typescript-execution',
        'workspace-export-grouped-oxc-execution',
        'workspace-export-resolution-request',
        'workspace-export-typescript-resolution',
        'workspace-export-oxc-resolution',
        'workspace-export-result-expansion',
        'workspace-export-resolution-request',
        'workspace-export-typescript-resolution',
        'workspace-export-oxc-resolution',
        'workspace-export-result-expansion',
      ]);

      const first = index.get(profiles[0]!.configPath, manifest.name);
      const second = index.get(profiles[1]!.configPath, manifest.name);

      expect(first).not.toBe(second);
      expect(first).toEqual(second);

      if (first && second) {
        first.packageName = 'mutated';
        expect(second.packageName).toBe(manifest.name);
      }

      const fallbackMeasurements: {
        readonly count?: number;
        readonly kind?: string;
        readonly name: string;
      }[] = [];
      const fallbackProfiles = profiles.map((profile) => ({
        ...profile,
        options: {
          futureResolutionOption: true,
        } as ts.CompilerOptions,
      }));

      typeScriptResolver.mockClear();
      await createWorkspaceExportsResolutionIndex({
        config,
        importAnalysis,
        metrics: {
          record: (measurement) => {
            fallbackMeasurements.push(measurement);
          },
        },
        packages: [workspacePackage],
        profiles: fallbackProfiles,
      });

      expect(typeScriptResolver).toHaveBeenCalledTimes(2);
      expect(
        fallbackMeasurements.filter(
          (measurement) =>
            measurement.name === 'workspace-export-typescript-profile-fallback',
        ),
      ).toEqual([
        expect.objectContaining({
          count: 2,
          kind: 'unclassified-compiler-option',
        }),
      ]);

      await rm(path.join(packageDirectory, 'package.json'));
      typeScriptResolver.mockClear();
      oxcResolver.mockClear();

      await createWorkspaceExportsResolutionIndex({
        config,
        importAnalysis,
        packages: [workspacePackage],
        profiles,
      });

      expect(typeScriptResolver).toHaveBeenCalledTimes(2);
      expect(oxcResolver).toHaveBeenCalledTimes(1);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});
