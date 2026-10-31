import type { ResolvedLiminaConfig, SourceCheckConfig } from '#config/runner';
import { resolveGeneratedGraphCheckers } from '#core/build-graph/runner';
import {
  createImportAnalysisContext,
  parseProject,
} from '#core/import-graph/context';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { readAstroTestToolchain } from '@limina/gates/test-support/astro-toolchain';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { LiminaStructuredError } from '../check-reporting/errors';
import { projectSupplementalPrerequisite } from '../core/build-graph/compilation-prerequisite';
import * as generatedConfigs from '../core/build-graph/generated-configs';
import type { DependencyAnalysisResult } from '../core/build-graph/types';
import type { SupplementalResolutionRequest } from '../core/import-analysis/supplemental-resolution';
import { createManagedOutputDeclarationLookup } from '../core/import-graph/managed-output-provider';
import { createProjectDependencyCaches } from '../core/project-dependencies/runner';
import * as nativeFactory from '../core/typescript-semantic/native-semantic-factory';
import { VueSemanticContextManager } from '../core/vue-semantic/context';
import { collectVueRequestInventory } from '../core/vue-semantic/request-inventory';
import { summarizeCompilationObligation } from '../domain/analysis/native-obligation';
import { prepareAndMaterializeGeneratedTsconfigGraph as prepareGeneratedTsconfigGraph } from './helpers/generated-graph';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createFixturePathResolver, toPortablePath } from './helpers/path';

const execFileAsync = promisify(execFile);
const requireFromTest = createRequire(import.meta.url);

function resolveInstalledPackageRoot(options: {
  installedName: string;
  packageName: string;
}): string {
  const readPackageName = (manifestPath: string): string | undefined => {
    try {
      return (
        JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
      ).name;
    } catch {
      return undefined;
    }
  };
  try {
    const manifestPath = requireFromTest.resolve(
      `${options.installedName}/package.json`,
    );
    if (readPackageName(manifestPath) === options.packageName) {
      return path.dirname(manifestPath);
    }
  } catch {
    // Packages may intentionally hide package.json behind exports.
  }
  let directory = path.dirname(requireFromTest.resolve(options.installedName));
  while (true) {
    if (
      readPackageName(path.join(directory, 'package.json')) ===
      options.packageName
    )
      return directory;
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(
        `Unable to find the ${options.packageName} package root for ${options.installedName}.`,
      );
    }
    directory = parent;
  }
}

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function linkInstalledPackage(options: {
  installedName: string;
  packageName: string;
  rootDir: string;
}): Promise<void> {
  const packageRoot = resolveInstalledPackageRoot({
    installedName: options.installedName,
    packageName: options.packageName,
  });
  const segments = options.packageName.split('/');
  const packageBaseName = segments.pop()!;
  const nodeModulesDirectory = path.join(
    options.rootDir,
    'node_modules',
    ...segments,
  );
  await mkdir(nodeModulesDirectory, { recursive: true });
  await symlink(
    packageRoot,
    path.join(nodeModulesDirectory, packageBaseName),
    'junction',
  );
}

async function linkAstroToolchain(rootDirectory: string): Promise<void> {
  await Promise.all([
    linkInstalledPackage({
      installedName: '@astrojs/check',
      packageName: '@astrojs/check',
      rootDir: rootDirectory,
    }),
    linkInstalledPackage({
      installedName: 'astro',
      packageName: 'astro',
      rootDir: rootDirectory,
    }),
    linkInstalledPackage({
      installedName: 'typescript',
      packageName: 'typescript',
      rootDir: rootDirectory,
    }),
  ]);
}

async function linkVueToolchain(rootDirectory: string): Promise<void> {
  const vueTscPackagePath = requireFromTest.resolve('vue-tsc/package.json');
  const nodeModulesDirectory = path.join(rootDirectory, 'node_modules');

  await mkdir(nodeModulesDirectory, { recursive: true });
  await symlink(
    path.dirname(vueTscPackagePath),
    path.join(nodeModulesDirectory, 'vue-tsc'),
    'junction',
  );
}

async function createFixture(
  files: Record<string, string>,
  options: {
    astroToolchain?: boolean;
    source?: SourceCheckConfig;
    svelteCompiler?: boolean;
    svelteTransform?: boolean;
  } = {},
): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
  path: ReturnType<typeof createFixturePathResolver>;
}> {
  const rootDirectoryTemporaryPath = await mkdtemp(
    path.join(tmpdir(), 'limina-generated-graph-'),
  );
  const rootDirectory = await realpath(rootDirectoryTemporaryPath);
  const hasAstro = Object.keys(files).some((filePath) =>
    filePath.endsWith('.astro'),
  );
  const hasSvelte = Object.keys(files).some((filePath) =>
    filePath.endsWith('.svelte'),
  );
  const fixtureFiles = {
    'package.json': `${JSON.stringify(
      {
        dependencies: hasAstro
          ? {
              ...readAstroTestToolchain(requireFromTest).dependencies,
            }
          : undefined,
        name: 'root',
        private: true,
      },
      null,
      2,
    )}\n`,
    'pnpm-workspace.yaml': 'packages:\n  - app\n  - packages/*\n',
    ...files,
  };

  for (const [relativePath, text] of Object.entries(fixtureFiles)) {
    await writeText(path.join(rootDirectory, relativePath), text);
  }
  await linkVueToolchain(rootDirectory);
  if (hasSvelte && !hasAstro) {
    await linkInstalledPackage({
      installedName: 'typescript',
      packageName: 'typescript',
      rootDir: rootDirectory,
    });
  }
  if (hasSvelte && options.svelteCompiler !== false) {
    await linkInstalledPackage({
      installedName: 'svelte-v4-min',
      packageName: 'svelte',
      rootDir: rootDirectory,
    });
  }
  if (hasSvelte && options.svelteTransform !== false) {
    await linkInstalledPackage({
      installedName: 'svelte2tsx',
      packageName: 'svelte2tsx',
      rootDir: rootDirectory,
    });
  }
  if (hasAstro && options.astroToolchain !== false) {
    await linkAstroToolchain(rootDirectory);
  }

  return {
    path: createFixturePathResolver(rootDirectory),
    cleanup: async () => {
      await rm(rootDirectory, { force: true, recursive: true });
    },
    config: withFixtureGovernanceRoot({
      configPath: path.join(rootDirectory, 'limina.config.mjs'),
      rootDir: rootDirectory,
      scope: {
        checkers: {
          tsc: {
            include: ['packages/**/tsconfig.json'],
          },
        },
      },
      ...(options.source !== undefined && { source: options.source }),
    }),
    rootDir: rootDirectory,
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readGeneratedIndexDeclaration(
  rootDirectory: string,
): Promise<string> {
  const matches = (await readdir(rootDirectory, { recursive: true })).filter(
    (filePath) => path.basename(filePath) === 'index.d.ts',
  );
  expect(matches).toHaveLength(1);
  return readFile(path.join(rootDirectory, matches[0]!), 'utf8');
}

async function linkWorkspacePackage(
  rootDirectory: string,
  importer: string,
  target: string,
  packageName: string,
): Promise<void> {
  const [scope, name] = packageName.split('/', 2);
  const nodeModulesDirectory =
    scope && name
      ? path.join(rootDirectory, importer, 'node_modules', scope)
      : path.join(rootDirectory, importer, 'node_modules');

  await mkdir(nodeModulesDirectory, {
    recursive: true,
  });
  await symlink(
    path.relative(nodeModulesDirectory, path.join(rootDirectory, target)),
    path.join(nodeModulesDirectory, name ?? packageName),
  );
}

function managedOutputCompilerOptions(): Record<string, unknown> {
  return {
    module: 'ESNext',
    moduleResolution: 'bundler',
    strict: true,
    target: 'ES2023',
    types: [],
  };
}

function createSpiedImportAnalysis() {
  const base = createImportAnalysisContext();
  const resolveSupplementalImport = vi.fn(base.resolveSupplementalImport!);
  return {
    context: { ...base, resolveSupplementalImport },
    resolveSupplementalImport,
  };
}

async function readGeneratedReferences(options: {
  checkerName?: string;
  projectRelativePath: string;
  rootDir: string;
}): Promise<{ path: string }[]> {
  const checkerName = options.checkerName ?? 'tsc';
  const generatedConfig = JSON.parse(
    await readFile(
      path.join(
        options.rootDir,
        `.limina/tsconfig/checkers/${checkerName}/projects/${options.projectRelativePath}/tsconfig.dts.json`,
      ),
      'utf8',
    ),
  ) as {
    references?: { path: string }[];
  };

  return generatedConfig.references ?? [];
}

describe('prepareGeneratedTsconfigGraph', () => {
  it.each(['tsc', 'vue-tsc'])(
    'respects Native coverage and framework authority for non-root type environments: %s',
    async (checker) => {
      const options = {
        composite: true,
        declaration: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        target: 'ES2022',
        types: [],
      };
      const fixture = await createFixture({
        'packages/app/package.json': '{"name":"@example/app","private":true}',
        'packages/core/package.json': '{"name":"@example/core","private":true}',
        'packages/model/package.json':
          '{"name":"@example/model","private":true}',
        'packages/app/tsconfig.json': JSON.stringify({
          compilerOptions: { ...options, types: ['./env'] },
          files: ['src/index.ts'],
        }),
        'packages/core/tsconfig.json': JSON.stringify({
          compilerOptions: options,
          files: ['src/index.ts'],
        }),
        'packages/model/tsconfig.json': JSON.stringify({
          compilerOptions: options,
          files: ['src/index.ts'],
        }),
        'packages/app/src/index.ts': 'export const app = 1;',
        'packages/app/env.d.ts':
          '/** Example: import("nonexistent-documentation-example") */\nimport type { Core } from "../core/src/index"; declare global { var core: Core; }',
        'packages/core/src/index.ts':
          'import type { Model } from "../../model/src/index"; export type Core = Model;',
        'packages/model/src/index.ts':
          'export interface Model { value: string }',
      });
      try {
        const graph = await prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            ...fixture.config.scope,
            checkers: { [checker]: { include: ['packages/**/tsconfig.json'] } },
          },
        });
        const app = graph.governedSources
          .values()
          .flatMap((units) => units.values())
          .find(
            (project) =>
              project.configPath === fixture.path('packages/app/tsconfig.json'),
          )!;
        expect(app.ownedFileNames).toEqual([
          fixture.path('packages/app/src/index.ts'),
        ]);
        expect(
          graph.dependencyEdges
            .filter((edge) => edge.fromConfigPath === app.configPath)
            .map((edge) => edge.toConfigPath),
        ).toEqual([fixture.path('packages/core/tsconfig.json')]);
        expect(graph.dependencyEdges).toHaveLength(2);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('accepts external package aliases without inventing canonical owner conflicts', async () => {
    const fixture = await createFixture({
      'packages/a/src/index.ts':
        "import { value } from '@example/shared'; export const used = value;",
      'packages/a/tsconfig.json': json({
        compilerOptions: {
          ...managedOutputCompilerOptions(),
          preserveSymlinks: true,
        },
        include: ['src/**/*'],
      }),
      'packages/one/tsconfig.json': json({
        files: [],
        references: [{ path: '../shared/tsconfig.one.json' }],
      }),
      'packages/two/tsconfig.json': json({
        files: [],
        references: [{ path: '../shared/tsconfig.two.json' }],
      }),
      'packages/shared/package.json': json({
        name: '@example/shared',
        exports: './src/value.ts',
      }),
      'packages/shared/src/value.ts': 'export const value = 1;',
      'packages/shared/tsconfig.one.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
      }),
      'packages/shared/tsconfig.two.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
      }),
    });
    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/a',
        'packages/shared',
        '@example/shared',
      );
      await expect(
        resolveGeneratedGraphCheckers({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        }),
      ).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'tsc' })]),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['svelte', 'astro', 'vue'] as const)(
    'keeps native missing source requirements separate from %s semantic authority',
    async (family) => {
      const component =
        family === 'vue'
          ? '<template><div /></template>'
          : family === 'astro'
            ? '---\n---\n<div />'
            : '<div />';
      const fixture = await createFixture({
        'packages/a/src/index.ts':
          "import { value } from '../../b/src/value'; export const used = value;",
        'packages/a/tsconfig.json': json({
          compilerOptions: managedOutputCompilerOptions(),
          include: ['src/**/*'],
        }),
        'packages/b/src/value.ts': 'export const value = 1;',
        [`packages/b/src/App.${family}`]: component,
        'packages/b/tsconfig.json': json({
          compilerOptions: managedOutputCompilerOptions(),
          include: ['src/**/*'],
        }),
      });
      const analysis = createSpiedImportAnalysis();
      const config = {
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      };
      try {
        if (family === 'vue') {
          const result = await prepareGeneratedTsconfigGraph(config, {
            importAnalysisContext: analysis.context,
          });
          expect(
            result.ownershipPlan.typeConfigs.get(
              fixture.path('packages/a/tsconfig.json'),
            ),
          ).toMatchObject({
            semanticAuthority: { kind: 'locked', family: 'typescript' },
            finalOwner: 'vue-tsc',
          });
          expect(result.dependencyEdges).toMatchObject([
            { kind: 'declaration-provider' },
          ]);
        } else {
          const checkers = await resolveGeneratedGraphCheckers(config, {
            importAnalysisContext: analysis.context,
          });
          expect(checkers).toContainEqual(
            expect.objectContaining({
              name: 'tsc',
              include: ['packages/a/tsconfig.json'],
            }),
          );
          await expect(
            prepareGeneratedTsconfigGraph(config, {
              importAnalysisContext: analysis.context,
            }),
          ).rejects.toThrow(
            'Unable to map generated graph import to a declaration project',
          );
        }
        expect(analysis.resolveSupplementalImport).not.toHaveBeenCalled();
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(['svelte', 'astro'] as const)(
    'preserves %s scheduling for a native missing implementation prerequisite',
    async (family) => {
      const fixture = await createFixture({
        'packages/a/src/index.ts':
          "import { value } from '../../b/src/value'; export const used = value;",
        [`packages/a/src/App.${family}`]:
          family === 'astro' ? '---\n---\n<div />' : '<div />',
        'packages/a/tsconfig.json': json({
          compilerOptions: managedOutputCompilerOptions(),
          include: ['src/**/*'],
        }),
        'packages/b/src/value.ts': 'export const value = 1;',
        'packages/b/tsconfig.json': json({
          compilerOptions: managedOutputCompilerOptions(),
          include: ['src/**/*'],
        }),
      });
      try {
        const result = await prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        });
        expect(
          result.ownershipPlan.dependencyFacts.find(
            (fact) =>
              fact.consumerConfigPath ===
                fixture.path('packages/a/tsconfig.json') &&
              fact.importRecord.filePath ===
                fixture.path('packages/a/src/index.ts'),
          ),
        ).toMatchObject({
          typeEvidenceKind: 'unobserved',
          referenceRequirement: { kind: 'compiler-membership' },
        });
        expect(result.dependencyEdges).toMatchObject([
          {
            kind: 'framework-schedule',
            toConfigPath: fixture.path('packages/b/tsconfig.json'),
          },
        ]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('keeps a declaration support companion out of Oxc ownership rescue', async () => {
    const fixture = await createFixture({
      'packages/a/src/index.ts':
        "import Component from '../../b/src/App.svelte'; export const used = Component;",
      'packages/a/tsconfig.json': json({
        compilerOptions: {
          ...managedOutputCompilerOptions(),
          allowArbitraryExtensions: true,
        },
        include: ['src/**/*'],
      }),
      'packages/b/src/App.svelte': '<div />',
      'packages/b/src/App.d.svelte.ts':
        'declare const component: unknown; export default component;',
      'packages/b/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
      }),
    });
    const analysis = createSpiedImportAnalysis();
    try {
      await expect(
        prepareGeneratedTsconfigGraph(
          {
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: { auto: {} },
            },
          },
          { importAnalysisContext: analysis.context },
        ),
      ).rejects.toThrow('has no provider with checker tsc');
      expect(analysis.resolveSupplementalImport).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps a leaf with files empty when an extended config supplies the effective include', async () => {
    const fixture = await createFixture({
      'packages/pkg/base.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/pkg/package.json': json({
        name: '@example/pkg',
        private: true,
      }),
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        extends: './base.json',
        files: [],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });
      const sourceConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/pkg/tsconfig.json'),
      );
      const generatedConfigPath = result.sourceToDts
        .get('tsc')
        ?.get(sourceConfigPath);

      expect(generatedConfigPath).toBeDefined();
      expect(
        parseProject(fixture.config, generatedConfigPath!).fileNames.map(
          normalizeAbsolutePath,
        ),
      ).toContain(
        normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/pkg/src/index.ts'),
        ),
      );
      expect(
        result.manifest.checkers.tsc?.sourceToDts['packages/pkg/tsconfig.json'],
      ).toBeDefined();
      const generatedConfig = JSON.parse(
        await readFile(generatedConfigPath!, 'utf8'),
      ) as { compilerOptions: Record<string, unknown> };
      expect(
        generatedConfig.compilerOptions.rewriteRelativeImportExtensions,
      ).toBeUndefined();
      expect(result.manifest.checkers.tsc?.roots).toEqual([
        'packages/pkg/tsconfig.json',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps an explicit JSON effective root in auto-checker semantic preparation', async () => {
    const fixture = await createFixture({
      'packages/pkg/package.json': json({
        name: '@example/pkg',
        private: true,
      }),
      'packages/pkg/src/data.json': '{"value":true}\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
        },
        files: ['src/data.json'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });
      const configPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/pkg/tsconfig.json'),
      );
      const jsonPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/pkg/src/data.json'),
      );

      expect(result.sourceToDts.get('tsc')?.get(configPath)).toBeDefined();
      expect(
        result.governedSources.get('tsc')?.get(configPath)?.ownedFileNames,
      ).toContain(jsonPath);
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves explicitly configured typeRoots in generated declarations', async () => {
    const fixture = await createFixture({
      'packages/pkg/package.json': json({
        name: '@example/pkg',
        private: true,
      }),
      'packages/pkg/custom-types/index.d.ts': 'declare const custom: true;\n',
      'packages/pkg/node_modules/placeholder/index.d.ts': 'export {};\n',
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          typeRoots: ['./custom-types'],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });
      const sourceConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/pkg/tsconfig.json'),
      );
      const generatedConfigPath = result.sourceToDts
        .get('tsc')
        ?.get(sourceConfigPath);

      expect(generatedConfigPath).toBeDefined();
      if (generatedConfigPath === undefined) return;

      expect(
        parseProject(fixture.config, generatedConfigPath).options.typeRoots,
      ).toEqual([
        normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/pkg/custom-types'),
        ),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves the nearest inherited typeRoots without merging the chain', async () => {
    const fixture = await createFixture({
      'packages/pkg/package.json': json({
        name: '@example/pkg',
        private: true,
      }),
      'packages/pkg/base-a.json': json({
        extends: './base-b.json',
      }),
      'packages/pkg/base-b.json': json({
        compilerOptions: {
          typeRoots: ['./base-b-types'],
        },
        extends: './root.json',
      }),
      'packages/pkg/base-b-types/index.d.ts': 'declare const baseB: true;\n',
      'packages/pkg/node_modules/placeholder/index.d.ts': 'export {};\n',
      'packages/pkg/root-types/index.d.ts': 'declare const root: true;\n',
      'packages/pkg/root.json': json({
        compilerOptions: {
          typeRoots: ['./root-types'],
        },
      }),
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        extends: './base-a.json',
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });
      const sourceConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/pkg/tsconfig.json'),
      );
      const generatedConfigPath = result.sourceToDts
        .get('tsc')
        ?.get(sourceConfigPath);

      expect(generatedConfigPath).toBeDefined();
      if (generatedConfigPath === undefined) return;

      expect(
        parseProject(fixture.config, generatedConfigPath).options.typeRoots,
      ).toEqual([
        normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/pkg/base-b-types'),
        ),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps an explicitly empty typeRoots array disabled in generated declarations', async () => {
    const fixture = await createFixture({
      'packages/pkg/package.json': json({
        name: '@example/pkg',
        private: true,
      }),
      'packages/pkg/node_modules/placeholder/index.d.ts': 'export {};\n',
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          typeRoots: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });
      const sourceConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/pkg/tsconfig.json'),
      );
      const generatedConfigPath = result.sourceToDts
        .get('tsc')
        ?.get(sourceConfigPath);

      expect(generatedConfigPath).toBeDefined();
      if (generatedConfigPath === undefined) return;

      expect(
        parseProject(fixture.config, generatedConfigPath).options.typeRoots,
      ).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('orders standard @types roots before bare node_modules fallbacks', async () => {
    const fixture = await createFixture({
      'node_modules/@types/root/index.d.ts': 'export {};\n',
      'node_modules/root-package/index.d.ts': 'export {};\n',
      'packages/pkg/node_modules/@types/local/index.d.ts': 'export {};\n',
      'packages/pkg/node_modules/vite/client.d.ts': 'export {};\n',
      'packages/pkg/package.json': json({
        name: '@example/pkg',
        private: true,
      }),
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      const sourceConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/pkg/tsconfig.json'),
      );
      const generatedConfigPath = result.sourceToDts
        .get('tsc')
        ?.get(sourceConfigPath);

      expect(generatedConfigPath).toBeDefined();
      if (generatedConfigPath === undefined) return;

      const generatedConfig = JSON.parse(
        await readFile(generatedConfigPath, 'utf8'),
      ) as { compilerOptions: { typeRoots?: string[] } };
      expect(
        generatedConfig.compilerOptions.typeRoots?.map((typeRoot) =>
          normalizeAbsolutePath(
            path.resolve(path.dirname(generatedConfigPath), typeRoot),
          ),
        ),
      ).toEqual([
        normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/pkg/node_modules/@types'),
        ),
        normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/pkg/node_modules'),
        ),
        normalizeAbsolutePath(
          path.join(fixture.rootDir, 'node_modules/@types'),
        ),
        normalizeAbsolutePath(path.join(fixture.rootDir, 'node_modules')),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not register a truly empty leaf as a generated project', async () => {
    const fixture = await createFixture({
      'packages/pkg/package.json': json({
        name: '@example/pkg',
        private: true,
      }),
      'packages/pkg/tsconfig.json': json({
        files: [],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      const sourceConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/pkg/tsconfig.json'),
      );

      expect(
        result.sourceToDts.get('tsc')?.has(sourceConfigPath) ?? false,
      ).toBe(false);
      expect(
        result.manifest.checkers.tsc?.sourceToDts['packages/pkg/tsconfig.json'],
      ).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([undefined, false, true])(
    'preserves TS extension imports in declarations when rewriting is enabled and allowImportingTsExtensions is %s',
    async (allowImportingTsExtensions) => {
      const fixture = await createFixture({
        'packages/pkg/package.json': json({
          name: '@example/pkg',
          private: true,
        }),
        'packages/pkg/src/index.ts': "export { value } from './value.ts';\n",
        'packages/pkg/src/value.ts': 'export const value = 1;\n',
        'packages/pkg/tsconfig.json': json({
          compilerOptions: {
            allowImportingTsExtensions,
            module: 'ESNext',
            moduleResolution: 'bundler',
            noEmit: true,
            rewriteRelativeImportExtensions: true,
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      });

      try {
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        const generatedConfig = JSON.parse(
          await readFile(
            path.join(
              fixture.rootDir,
              '.limina/tsconfig/checkers/tsc/projects/packages/pkg/tsconfig.dts.json',
            ),
            'utf8',
          ),
        ) as {
          compilerOptions: {
            rewriteRelativeImportExtensions?: boolean;
          };
        };

        expect(
          generatedConfig.compilerOptions.rewriteRelativeImportExtensions,
        ).toBe(false);
        await execFileAsync(
          process.execPath,
          [
            requireFromTest.resolve('typescript/bin/tsc'),
            '-b',
            graph.checkerEntries.get('tsc')!,
            '--pretty',
            'false',
          ],
          { cwd: fixture.rootDir },
        );
        expect(
          await readGeneratedIndexDeclaration(fixture.path('.limina/dts')),
        ).toContain("export { value } from './value.ts';");
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([
    ['Button.d.ts', 'Button.ts'],
    ['Button.d.ts', 'Button.tsx'],
    ['Button.d.mts', 'Button.mts'],
    ['Button.d.cts', 'Button.cts'],
    ['Button.vue.d.ts', 'Button.vue'],
  ])(
    'reverse-maps managed %s output to owned %s source',
    (declarationName, sourceName) => {
      const rootDirectory = path.join(process.cwd(), 'virtual-managed-source');
      const sourceFilePath = path.join(rootDirectory, 'src', sourceName);
      const lookup = createManagedOutputDeclarationLookup([
        {
          checkerName: 'test',
          extensions: ['.ts', '.tsx', '.mts', '.cts', '.vue'],
          outputOptions: {
            outDir: path.join(rootDirectory, 'dist'),
            rootDir: path.join(rootDirectory, 'src'),
          },
          ownedFileNames: [sourceFilePath],
          sourceConfigPath: path.join(rootDirectory, 'tsconfig.json'),
        },
      ]);

      const mappedSourcePath = toPortablePath(
        lookup.resolve(path.join(rootDirectory, 'dist', declarationName))!
          .mappedSourceFilePath,
      );
      expect(mappedSourcePath).toBe(toPortablePath(sourceFilePath));
    },
  );

  it('omits an excluded overlap package from generated graph preparation', async () => {
    const fixture = await createFixture({
      'packages/app/package.json': json({
        name: '@example/app',
        private: true,
        scripts: {
          build: 'limina build tsconfig.lib.dts.json',
        },
      }),
      'packages/app/pnpm-workspace.yaml': 'packages: []\n',
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.dts.json',
          },
        ],
      }),
      'packages/app/tsconfig.lib.dts.json': json({
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          module: 'ESNext',
          moduleResolution: 'bundler',
          outDir: './dist',
          rootDir: '.',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
        liminaOptions: {
          outputs: {
            outDir: './dist',
            rootDir: '.',
          },
        },
      }),
    });

    try {
      (fixture.config.scope ??= {}).regions = {
        exclude: [
          {
            include: ['packages/app/**'],
            kind: 'workspace-package',
            reason: 'Nested app workspace is checked separately.',
          },
        ],
      };

      const result = await prepareGeneratedTsconfigGraph(fixture.config);

      expect(JSON.stringify(result.manifest)).not.toContain('packages/app');
      expect(JSON.stringify(result.manifest)).not.toContain('@example/app');
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses auto checkers when scope.checkers is omitted', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {},
      });

      expect(result.checkers).toMatchObject([
        {
          include: ['packages/pkg/tsconfig.json'],
          name: 'tsc',
        },
      ]);
      expect(Object.keys(result.manifest.checkers)).toEqual(['tsc']);
      expect(result.manifest.checkers.tsc?.sourceToDts).toMatchObject({
        'packages/pkg/tsconfig.json':
          '.limina/tsconfig/checkers/tsc/projects/packages/pkg/tsconfig.dts.json',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses tsgo for ordinary auto scopes while keeping Vue scopes on vue-tsc', async () => {
    const fixture = await createFixture({
      'packages/native/src/index.ts': 'export const value = 1;\n',
      'packages/native/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/vue/src/App.vue':
        '<script setup lang="ts">const value = 1;</script>\n',
      'packages/vue/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: { useTsgo: true } },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          include: ['packages/native/tsconfig.json'],
          name: 'tsgo',
        },
        {
          include: ['packages/vue/tsconfig.json'],
          name: 'vue-tsc',
        },
      ]);
      expect(Object.keys(result.manifest.checkers)).toEqual([
        'tsgo',
        'vue-tsc',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects removed root limina metadata in an activated checker source config', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
        limina: 'runtime',
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow(
        'root-level limina metadata is not part of the Limina 0.2.0 tsconfig contract',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not reject removed metadata in an unactivated tsconfig', async () => {
    const fixture = await createFixture({
      'packages/active/src/index.ts': 'export const value = 1;\n',
      'packages/active/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/inactive/tsconfig.unused.json': json({
        limina: 'runtime',
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);

      expect(result.manifest.checkers.tsc?.roots).toEqual([
        'packages/active/tsconfig.json',
      ]);
      expect(JSON.stringify(result.manifest)).not.toContain(
        'tsconfig.unused.json',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts current liminaOptions and unrelated root extensions on activated configs', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        customTool: {
          enabled: true,
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
        liminaOptions: {
          graphRules: ['runtime'],
          outputs: {
            outDir: './dist',
          },
        },
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);

      expect(result.manifest.checkers.tsc?.roots).toEqual([
        'packages/pkg/tsconfig.json',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not let explicit checker discovery select nested region tsconfigs', async () => {
    const fixture = await createFixture({
      'packages/a/fixture/pnpm-workspace.yaml': 'packages: []\n',
      'packages/a/fixture/src/index.ts': 'export const nested = 1;\n',
      'packages/a/fixture/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/a/src/index.ts': 'export const value = 1;\n',
      'packages/a/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: ['**/tsconfig.json'],
            },
          },
        },
      });
      expect(result.manifest.checkers.tsc?.roots).toEqual([
        'packages/a/tsconfig.json',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not let auto checker discovery select nested region tsconfig files', async () => {
    const fixture = await createFixture({
      'packages/a/fixture/pnpm-workspace.yaml': 'packages: []\n',
      'packages/a/fixture/src/index.ts': 'export const nested = 1;\n',
      'packages/a/fixture/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/a/src/index.ts': 'export const value = 1;\n',
      'packages/a/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {},
      });

      expect(result.checkers).toMatchObject([
        {
          include: ['packages/a/tsconfig.json'],
          name: 'tsc',
        },
      ]);
      expect(JSON.stringify(result.manifest)).not.toContain(
        'packages/a/fixture',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('resolves region-scoped auto checkers directly for checker-help discovery', async () => {
    const fixture = await createFixture({
      'packages/a/fixture/pnpm-workspace.yaml': 'packages: []\n',
      'packages/a/fixture/src/index.ts': 'export const nested = 1;\n',
      'packages/a/fixture/tsconfig.json': json({
        include: ['src/**/*.ts'],
      }),
      'packages/a/src/index.ts': 'export const value = 1;\n',
      'packages/a/tsconfig.json': json({
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const checkers = await resolveGeneratedGraphCheckers({
        ...fixture.config,
        scope: {},
      });
      expect(checkers).toMatchObject([
        {
          include: ['packages/a/tsconfig.json'],
          name: 'tsc',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports cross-region references with boundary details', async () => {
    const fixture = await createFixture({
      'packages/a/fixture/pnpm-workspace.yaml': 'packages: []\n',
      'packages/a/fixture/tsconfig.lib.json': json({
        include: ['src/**/*.ts'],
      }),
      'packages/a/tsconfig.json': json({
        files: [],
        references: [{ path: './fixture/tsconfig.lib.json' }],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow(
        /Referenced checker source config is outside activated workspace package regions:[\s\S]*boundary kind: workspace-root[\s\S]*packages\/a\/fixture/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports cross-region references with no matching boundary', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': json({
        name: '@example/a',
        private: true,
      }),
      'packages/a/tsconfig.json': json({
        files: [],
        references: [],
      }),
    });
    const outsideRoot = `${fixture.rootDir}-outside`;

    try {
      const outsideConfigPath = path.join(outsideRoot, 'tsconfig.lib.json');
      await writeText(
        path.join(outsideRoot, 'src/index.ts'),
        'export const outside = 1;\n',
      );
      await writeText(outsideConfigPath, json({ include: ['src/**/*.ts'] }));
      const referenceConfig = json({
        files: [],
        references: [
          {
            path: path.relative(
              path.join(fixture.rootDir, 'packages/a'),
              outsideConfigPath,
            ),
          },
        ],
      });
      await writeText(
        path.join(fixture.rootDir, 'packages/a/tsconfig.json'),
        referenceConfig,
      );
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow(
        /Referenced checker source config is outside activated workspace package regions:[\s\S]*not owned by any current-run activated workspace package/u,
      );
    } finally {
      await rm(outsideRoot, { force: true, recursive: true });
      await fixture.cleanup();
    }
  });

  it('rejects generated graph imports across governance boundaries', async () => {
    const fixture = await createFixture({
      'packages/a/fixture/pnpm-workspace.yaml': 'packages: []\n',
      'packages/a/fixture/src/index.ts': 'export const nested = 1;\n',
      'packages/a/src/index.ts':
        "import { nested } from '../fixture/src/index';\nexport const value = nested;\n",
      'packages/a/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {},
        }),
      ).rejects.toThrow('Generated graph import crosses governance boundary');
    } finally {
      await fixture.cleanup();
    }
  });

  it('routes Vue auto scopes to vue-tsc', async () => {
    const fixture = await createFixture({
      'packages/app/src/App.vue':
        '<script setup lang="ts">const value = 1;</script>\n',
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
      }),
    });
    const analysis = createSpiedImportAnalysis();

    try {
      const result = await prepareGeneratedTsconfigGraph(
        {
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        },
        { importAnalysisContext: analysis.context },
      );

      expect(result.checkers).toMatchObject([
        {
          include: ['packages/app/tsconfig.json'],
          name: 'vue-tsc',
        },
      ]);
      expect(Object.keys(result.manifest.checkers)).toEqual(['vue-tsc']);
      expect(result.manifest.checkers['vue-tsc']?.sourceToDts).toMatchObject({
        'packages/app/tsconfig.json':
          '.limina/tsconfig/checkers/vue-tsc/projects/packages/app/tsconfig.dts.json',
      });
      expect(analysis.resolveSupplementalImport).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    'unknown',
    'asset',
    'ambient',
    'noResolve',
    'augmentation',
  ] as const)(
    'respects compiler input proof for custom framework aliases: %s',
    async (mode) => {
      const hasCustomProfile = mode !== 'asset';
      const declaration =
        mode === 'ambient'
          ? 'declare module "@example/custom" { export const value: number; } declare const value: typeof import("@example/custom");'
          : mode === 'augmentation'
            ? 'export {}; declare module "@example/custom" { interface Added {} }'
            : undefined;
      const fixture = await createFixture({
        'packages/app/src/index.ts':
          declaration === undefined
            ? "import Component from '@example/custom'; export const value = Component;"
            : 'export const anchor = 1;',
        ...(declaration !== undefined && {
          'packages/app/src/ambient.d.ts': declaration,
        }),
        'packages/app/tsconfig.json': json({
          compilerOptions: {
            ...managedOutputCompilerOptions(),
            preserveSymlinks: true,
            ...(mode === 'noResolve' && { noResolve: true }),
          },
          include: ['src/**/*'],
        }),
        'packages/custom/package.json': json({
          name: '@example/custom',
          type: 'module',
          exports: { '.': './src/App.md' },
        }),
        'packages/custom/src/index.ts': 'export const value = 1;',
        'packages/custom/src/App.md':
          '<script setup lang="ts">const value = 1;</script>',
        'packages/custom/tsconfig.json': json({
          compilerOptions: managedOutputCompilerOptions(),
          include: ['src/**/*'],
          ...(hasCustomProfile && {
            vueCompilerOptions: { extensions: ['.vue', '.md'] },
          }),
        }),
      });
      const analysis = createSpiedImportAnalysis();
      try {
        await linkWorkspacePackage(
          fixture.rootDir,
          'packages/app',
          'packages/custom',
          '@example/custom',
        );
        const result = prepareGeneratedTsconfigGraph(
          {
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: { auto: {} },
            },
          },
          { importAnalysisContext: analysis.context },
        );
        if (mode === 'unknown')
          await expect(result).rejects.toThrow(
            'Pending supplemental target qualification unavailable',
          );
        else {
          const graph = await result;
          expect(graph.dependencyEdges).toEqual([]);
          expect(
            graph.checkers.find((checker) => checker.name === 'tsc')?.include,
          ).toContain('packages/app/tsconfig.json');
        }
        if (mode === 'unknown' || mode === 'asset')
          expect(
            analysis.resolveSupplementalImport.mock.results.some(
              (result) =>
                result.value?.target ===
                fixture.path(
                  'packages/app/node_modules/@example/custom/src/App.md',
                ),
            ),
          ).toBe(true);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('confirms custom Vue extensions from actual files instead of config hints alone', async () => {
    const fixture = await createFixture({
      'packages/custom/src/App.md':
        '<script setup lang="ts">const value = 1;</script>\n',
      'packages/custom/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
        vueCompilerOptions: { extensions: ['.vue', '.md'] },
      }),
      'packages/hint/src/index.ts': 'export const value = 1;\n',
      'packages/hint/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
        vueCompilerOptions: { extensions: ['.vue', '.md'] },
      }),
    });
    const analysis = createSpiedImportAnalysis();

    try {
      const result = await prepareGeneratedTsconfigGraph(
        {
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        },
        { importAnalysisContext: analysis.context },
      );
      const customConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/custom/tsconfig.json'),
      );
      const hintConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/hint/tsconfig.json'),
      );

      expect(result.checkers).toMatchObject([
        {
          include: [
            'packages/custom/tsconfig.json',
            'packages/hint/tsconfig.json',
          ],
          name: 'vue-tsc',
        },
      ]);
      expect(
        result.governedSources.get('vue-tsc')?.get(customConfigPath)
          ?.declarationFileNames,
      ).toEqual([
        normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/custom/src/App.md'),
        ),
      ]);
      expect(result.governedSources.get('vue-tsc')?.has(hintConfigPath)).toBe(
        true,
      );
      expect(analysis.resolveSupplementalImport).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses the owning leaf package root for framework imports in auto scopes', async () => {
    const fixture = await createFixture(
      {
        'packages/app/package.json': json({
          dependencies: {
            ...readAstroTestToolchain(requireFromTest).dependencies,
          },
          name: '@fixture/app',
          private: true,
        }),
        'packages/app/src/Page.astro':
          '---\nimport value from "./value";\nvoid value;\n---\n',
        'packages/app/src/value.ts': `export default 1;
`,
        'tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['packages/app/src/**/*'],
        }),
      },
      { astroToolchain: false },
    );

    try {
      await linkAstroToolchain(path.join(fixture.rootDir, 'packages/app'));
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          include: ['tsconfig.json'],
          name: 'astro',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('promotes TypeScript auto consumers that import Vue auto scopes', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { themeValue } from '../../theme/src/theme';\nexport const value = themeValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme/src/Theme.vue':
        '<script setup lang="ts">const value = 1;</script>\n',
      'packages/theme/src/theme.ts': 'export const themeValue = 1;\n',
      'packages/theme/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          include: [
            'packages/app/tsconfig.json',
            'packages/theme/tsconfig.json',
          ],
          name: 'vue-tsc',
        },
      ]);
      expect(Object.keys(result.manifest.checkers)).toEqual(['vue-tsc']);
      expect(result.manifest.dependencyEdges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cacheReuse: 'reusable',
            fromChecker: 'vue-tsc',
            kind: 'declaration-provider',
            toChecker: 'vue-tsc',
          }),
        ]),
      );
      expect(result.manifest.checkers['vue-tsc']?.sourceToDts).toMatchObject({
        'packages/app/tsconfig.json':
          '.limina/tsconfig/checkers/vue-tsc/projects/packages/app/tsconfig.dts.json',
        'packages/theme/tsconfig.json':
          '.limina/tsconfig/checkers/vue-tsc/projects/packages/theme/tsconfig.dts.json',
      });
      const appState = result.ownershipPlan.typeConfigs.get(
        normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/app/tsconfig.json'),
        ),
      );
      expect(appState).toMatchObject({
        finalOwner: 'vue-tsc',
        frozenSemanticAuthority: {
          family: 'typescript',
          kind: 'locked',
        },
        semanticAuthority: {
          family: 'typescript',
          kind: 'locked',
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('promotes TypeScript auto consumers transitively through dependency chains', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { sharedValue } from '../../shared/src/index';\nexport const value = sharedValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/shared/src/index.ts':
        "import { themeValue } from '../../theme/src/theme';\nexport const sharedValue = themeValue;\n",
      'packages/shared/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme/src/Theme.vue':
        '<script setup lang="ts">const value = 1;</script>\n',
      'packages/theme/src/theme.ts': 'export const themeValue = 1;\n',
      'packages/theme/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          include: [
            'packages/app/tsconfig.json',
            'packages/shared/tsconfig.json',
            'packages/theme/tsconfig.json',
          ],
          name: 'vue-tsc',
        },
      ]);
      expect(Object.keys(result.manifest.checkers)).toEqual(['vue-tsc']);
      expect(result.manifest.dependencyEdges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cacheReuse: 'reusable',
            fromChecker: 'vue-tsc',
            kind: 'declaration-provider',
            toChecker: 'vue-tsc',
          }),
        ]),
      );
      for (const projectPath of ['packages/app', 'packages/shared']) {
        const state = result.ownershipPlan.typeConfigs.get(
          normalizeAbsolutePath(
            path.join(fixture.rootDir, projectPath, 'tsconfig.json'),
          ),
        );
        expect(state).toMatchObject({
          finalOwner: 'vue-tsc',
          frozenSemanticAuthority: {
            family: 'typescript',
            kind: 'locked',
          },
          semanticAuthority: {
            family: 'typescript',
            kind: 'locked',
          },
        });
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps an explicit solution closure authoritative during dependency analysis', async () => {
    const fixture = await createFixture({
      'packages/svelte/src/Page.svelte': '<h1>Svelte</h1>\n',
      'packages/svelte/tsconfig.json': json({ include: ['src/**/*'] }),
      'packages/domain/src/client.ts':
        "import '../../svelte/src/Page.svelte';\nexport const client = true;\n",
      'packages/domain/src/server.ts': 'export const server = true;\n',
      'packages/domain/tsconfig.client.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/client.ts'],
      }),
      'packages/domain/tsconfig.json': json({
        files: [],
        references: [
          { path: './tsconfig.client.json' },
          { path: './tsconfig.server.json' },
        ],
      }),
      'packages/domain/tsconfig.server.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/server.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            'svelte-check': {
              include: ['packages/domain/tsconfig.json'],
            },
          },
        },
      });
      expect(result.manifest.ownership.configs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            config: 'packages/domain/tsconfig.client.json',
            owner: 'svelte-check',
          }),
          expect.objectContaining({
            config: 'packages/domain/tsconfig.server.json',
            owner: 'svelte-check',
          }),
        ]),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('locks an explicit owner through nested default solutions to a named terminal config', async () => {
    const fixture = await createFixture({
      'packages/app/tsconfig.json': json({
        files: [],
        references: [{ path: '../lib/tsconfig.json' }],
      }),
      'packages/lib/src/page.astro': '<h1>Astro</h1>\n',
      'packages/lib/tsconfig.json': json({
        files: [],
        references: [{ path: './tsconfig.lib.json' }],
      }),
      'packages/lib/tsconfig.lib.json': json({
        include: ['src/**/*'],
      }),
    });
    const analysis = createSpiedImportAnalysis();

    try {
      const result = await prepareGeneratedTsconfigGraph(
        {
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              astro: {
                include: ['packages/app/tsconfig.json'],
              },
            },
          },
        },
        { importAnalysisContext: analysis.context },
      );

      expect(result.manifest.ownership.configs).toContainEqual(
        expect.objectContaining({
          config: 'packages/lib/tsconfig.lib.json',
          owner: 'astro',
        }),
      );
      expect(result.manifest.checkers.astro?.sourceToDts).toBeUndefined();
      expect(analysis.resolveSupplementalImport).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('collects all dependency requirements before resolving a pending owner', async () => {
    const fixture = await createFixture({
      'packages/astro/src/Page.astro': '<h1>Astro</h1>\n',
      'packages/astro/tsconfig.json': json({ include: ['src/**/*'] }),
      'packages/consumer/src/index.ts': [
        "import '../../svelte/src/App.svelte';",
        "import '../../astro/src/Page.astro';",
        'export const value = true;',
        '',
      ].join('\n'),
      'packages/consumer/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
      'packages/svelte/src/App.svelte': '<h1>Svelte</h1>\n',
      'packages/svelte/tsconfig.json': json({ include: ['src/**/*'] }),
    });

    try {
      await expect(
        resolveGeneratedGraphCheckers({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        }),
      ).rejects.toThrow(
        /multiple framework checker requirements[\s\S]*astro[\s\S]*svelte-check/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports the same pending framework conflict in reverse import order', async () => {
    const fixture = await createFixture({
      'packages/astro/src/Page.astro': '<h1>Astro</h1>\n',
      'packages/astro/tsconfig.json': json({ include: ['src/**/*'] }),
      'packages/consumer/src/index.ts': [
        "import '../../astro/src/Page.astro';",
        "import '../../svelte/src/App.svelte';",
        'export const value = true;',
        '',
      ].join('\n'),
      'packages/consumer/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
      'packages/svelte/src/App.svelte': '<h1>Svelte</h1>\n',
      'packages/svelte/tsconfig.json': json({ include: ['src/**/*'] }),
    });
    const analysis = createSpiedImportAnalysis();

    try {
      await expect(
        resolveGeneratedGraphCheckers(
          {
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: { auto: {} },
            },
          },
          { importAnalysisContext: analysis.context },
        ),
      ).rejects.toThrow(
        /multiple framework checker requirements[\s\S]*astro[\s\S]*svelte-check/u,
      );
      expect(analysis.resolveSupplementalImport).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('projects nested shared solutions into independent checker roots and retains empty containers', async () => {
    const fixture = await createFixture({
      'packages/a/tsconfig.json': json({
        include: [],
        references: [
          { path: '../b' },
          { path: '../d/tsconfig.lib.json' },
          { path: '../e' },
          { path: '../b' },
        ],
      }),
      'packages/b/tsconfig.json': json({
        include: [],
        references: [{ path: '../c/tsconfig.lib.json' }],
      }),
      'packages/s/tsconfig.json': json({
        include: [],
        references: [{ path: '../c/tsconfig.lib.json' }],
      }),
      'packages/e/tsconfig.json': json({ include: [], references: [] }),
      'packages/c/tsconfig.lib.json': json({ include: ['src/**/*'] }),
      'packages/c/src/App.vue':
        '<script setup lang="ts">const value = 1;</script><template>{{value}}</template>',
      'packages/d/tsconfig.lib.json': json({ include: ['src/**/*.ts'] }),
      'packages/d/src/index.ts': 'export const value = 1;',
    });
    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: { checkers: { auto: {} } },
      });
      expect(
        result.ownershipPlan.solutions.get(
          fixture.path('packages/a/tsconfig.json'),
        )?.sourceConfigPaths,
      ).toEqual([
        fixture.path('packages/c/tsconfig.lib.json'),
        fixture.path('packages/d/tsconfig.lib.json'),
      ]);
      expect(result.manifest.ownership.solutions).toContainEqual({
        config: 'packages/e/tsconfig.json',
        sources: [],
        checkers: [],
      });
      for (const [checker, source] of [
        ['tsc', 'd'],
        ['vue-tsc', 'c'],
      ] as const) {
        const entry = result.checkerEntries.get(checker)!;
        const references = JSON.parse(
          result.generatedFiles.get(entry)!,
        ).references;
        expect(references).toHaveLength(1);
        expect(references[0].path).toContain(
          `packages/${source}/tsconfig.lib.dts.json`,
        );
        expect(result.governedSources.get(checker)?.size).toBe(1);
        expect(
          result.sourceToBuild
            .get(checker)
            ?.has(fixture.path('packages/a/tsconfig.json')),
        ).toBe(true);
      }
      expect(result.dependencyEdges).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('retains an entirely empty selected solution without a checker owner or build entry', async () => {
    const fixture = await createFixture({
      'packages/empty/tsconfig.json': json({ include: [], references: [] }),
    });
    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      expect(result.manifest.ownership.solutions).toEqual([
        {
          config: 'packages/empty/tsconfig.json',
          sources: [],
          checkers: [],
          declaredChecker: 'tsc',
        },
      ]);
      expect(result.checkerEntries.size).toBe(0);
      expect(result.governedSources.size).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('isolates framework ownership across overlapping solutions with a shared source', async () => {
    const fixture = await createFixture({
      'packages/a/src/App.svelte': '<h1>Svelte</h1>\n',
      'packages/a/tsconfig.lib.json': json({ include: ['src/**/*'] }),
      'packages/b/src/index.ts': 'export const value = true;\n',
      'packages/b/tsconfig.lib.json': json({ include: ['src/**/*.ts'] }),
      'packages/s1/tsconfig.json': json({
        files: [],
        references: [
          { path: '../a/tsconfig.lib.json' },
          { path: '../shared/tsconfig.lib.json' },
        ],
      }),
      'packages/s2/tsconfig.json': json({
        files: [],
        references: [
          { path: '../shared/tsconfig.lib.json' },
          { path: '../b/tsconfig.lib.json' },
        ],
      }),
      'packages/shared/src/index.ts': 'export const shared = true;\n',
      'packages/shared/tsconfig.lib.json': json({
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });
      expect(result.manifest.ownership.configs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            config: 'packages/b/tsconfig.lib.json',
            owner: 'tsc',
          }),
          expect.objectContaining({
            config: 'packages/shared/tsconfig.lib.json',
            owner: 'tsc',
          }),
        ]),
      );
      expect(
        new Set(
          result.manifest.ownership.solutions.flatMap(
            ({ checkers }) => checkers,
          ),
        ),
      ).toEqual(new Set(['svelte-check', 'tsc']));
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses one vue-tsc owner across a Vue declaration component', async () => {
    const fixture = await createFixture({
      'packages/provider/src/index.ts': 'export const value = true;\n',
      'packages/provider/tsconfig.json': json({ include: ['src/**/*.ts'] }),
      'packages/vue/src/App.vue': [
        '<script setup lang="ts">',
        "import { value } from '../../provider/src/index';",
        'void value;',
        '</script>',
        '',
      ].join('\n'),
      'packages/vue/tsconfig.json': json({ include: ['src/**/*'] }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });
      expect(result.checkers).toMatchObject([
        {
          include: [
            'packages/provider/tsconfig.json',
            'packages/vue/tsconfig.json',
          ],
          name: 'vue-tsc',
        },
      ]);
      const providerState = result.ownershipPlan.typeConfigs.get(
        normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/provider/tsconfig.json'),
        ),
      );
      const vueState = result.ownershipPlan.typeConfigs.get(
        normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/vue/tsconfig.json'),
        ),
      );
      expect(providerState).toMatchObject({
        finalOwner: 'vue-tsc',
        frozenSemanticAuthority: {
          family: 'typescript',
          kind: 'locked',
        },
        semanticAuthority: {
          family: 'typescript',
          kind: 'locked',
        },
      });
      expect(vueState).toMatchObject({
        finalOwner: 'vue-tsc',
        frozenSemanticAuthority: { family: 'vue', kind: 'locked' },
        semanticAuthority: { family: 'vue', kind: 'locked' },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps a resolved framework source relation despite an ambient module declaration', async () => {
    const fixture = await createFixture({
      'packages/consumer/src/framework.d.ts': `declare module '*.svelte' { const component: unknown; export default component; }
`,
      'packages/consumer/src/index.ts':
        "import Component from '../../svelte/src/App.svelte';\nexport const value = Component;\n",
      'packages/consumer/tsconfig.json': json({ include: ['src/**/*'] }),
      'packages/svelte/src/App.svelte': '<h1>Svelte</h1>\n',
      'packages/svelte/tsconfig.json': json({ include: ['src/**/*'] }),
    });
    const analysis = createSpiedImportAnalysis();

    try {
      const checkers = await resolveGeneratedGraphCheckers(
        {
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        },
        { importAnalysisContext: analysis.context },
      );
      expect(checkers).toMatchObject([
        {
          include: [
            'packages/consumer/tsconfig.json',
            'packages/svelte/tsconfig.json',
          ],
          name: 'svelte-check',
        },
      ]);
      expect(analysis.resolveSupplementalImport).toHaveBeenCalledWith(
        expect.objectContaining({
          specifier: '../../svelte/src/App.svelte',
          importer: fixture.path('packages/consumer/src/index.ts'),
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('respects a physical declaration support input as a framework domain boundary', async () => {
    const fixture = await createFixture({
      'packages/consumer/src/index.ts':
        "import Component from '../../svelte/src/App.svelte';\nexport const value = Component;\n",
      'packages/consumer/tsconfig.json': json({
        compilerOptions: {
          ...managedOutputCompilerOptions(),
          allowArbitraryExtensions: true,
        },
        include: ['src/**/*.ts'],
      }),
      'packages/svelte/src/App.d.svelte.ts': `declare const component: unknown;
export default component;
`,
      'packages/svelte/src/App.svelte': '<h1>Svelte</h1>\n',
      'packages/svelte/tsconfig.json': json({ include: ['src/**/*'] }),
    });
    const analysis = createSpiedImportAnalysis();

    try {
      await expect(
        prepareGeneratedTsconfigGraph(
          {
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: { auto: {} },
            },
          },
          { importAnalysisContext: analysis.context },
        ),
      ).rejects.toThrow('has no provider with checker tsc');
      expect(analysis.resolveSupplementalImport).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    {
      checker: 'astro',
      extension: 'astro',
    },
    {
      checker: 'svelte-check',
      extension: 'svelte',
    },
  ] as const)(
    'keeps an explicit $checker owner without manufacturing raw framework target evidence',
    async ({ checker, extension }) => {
      const fixture = await createFixture({
        'packages/consumer/src/index.ts': `import '../../provider/src/Component.${extension}';\nexport const value = true;\n`,
        'packages/consumer/tsconfig.json': json({
          include: ['src/**/*.ts'],
        }),
        [`packages/provider/src/Component.${extension}`]:
          '<h1>Framework</h1>\n',
        'packages/provider/tsconfig.json': json({ include: ['src/**/*'] }),
      });

      try {
        const result = await prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              [checker]: {
                include: ['packages/consumer/tsconfig.json'],
              },
            },
          },
        });
        expect(result.manifest.ownership.configs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              config: 'packages/consumer/tsconfig.json',
              owner: checker,
            }),
          ]),
        );
        expect(
          result.ownershipPlan.dependencyFacts.filter(
            (fact) =>
              fact.consumerConfigPath ===
              fixture.path('packages/consumer/tsconfig.json'),
          ),
        ).toEqual([]);
        expect(result.dependencyEdges).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([
    {
      checker: 'vue-tsc',
      extension: 'svelte',
    },
    {
      checker: 'astro',
      extension: 'svelte',
    },
    {
      checker: 'svelte-check',
      extension: 'astro',
    },
  ] as const)(
    'does not use dependency requirements to recolor an explicit $checker consumer',
    async ({ checker, extension }) => {
      const fixture = await createFixture({
        'packages/consumer/src/index.ts': `import '../../provider/src/Component.${extension}';\nexport const value = true;\n`,
        'packages/consumer/tsconfig.json': json({
          include: ['src/**/*.ts'],
        }),
        [`packages/provider/src/Component.${extension}`]:
          '<h1>Framework</h1>\n',
        'packages/provider/tsconfig.json': json({ include: ['src/**/*'] }),
      });

      try {
        const checkers = await resolveGeneratedGraphCheckers({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              [checker]: {
                include: ['packages/consumer/tsconfig.json'],
              },
            },
          },
        });
        expect(checkers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              include: ['packages/consumer/tsconfig.json'],
              name: checker,
            }),
          ]),
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('reports unknown qualification for a framework file excluded from its nearby config', async () => {
    const fixture = await createFixture({
      'packages/consumer/src/index.ts':
        "import '../../svelte/misc/Test.svelte';\nexport const value = true;\n",
      'packages/consumer/tsconfig.json': json({ include: ['src/**/*.ts'] }),
      'packages/svelte/misc/Test.svelte': '<h1>Excluded</h1>\n',
      'packages/svelte/src/App.svelte': '<h1>Included</h1>\n',
      'packages/svelte/tsconfig.json': json({
        exclude: ['misc/**/*'],
        include: ['src/**/*'],
      }),
    });

    try {
      await expect(
        resolveGeneratedGraphCheckers({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        }),
      ).rejects.toThrow(
        /Pending supplemental target qualification unavailable:.*\(uncovered\)/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a physical framework target with multiple actual memberships', async () => {
    const fixture = await createFixture({
      'packages/consumer/src/index.ts':
        "import '../../shared/src/App.svelte';\nexport const value = true;\n",
      'packages/consumer/tsconfig.json': json({ include: ['src/**/*.ts'] }),
      'packages/one/tsconfig.json': json({
        files: [],
        references: [{ path: '../shared/tsconfig.one.json' }],
      }),
      'packages/shared/src/App.svelte': '<h1>Shared</h1>\n',
      'packages/shared/tsconfig.one.json': json({
        include: ['src/**/*.svelte'],
      }),
      'packages/shared/tsconfig.two.json': json({
        include: ['src/**/*.svelte'],
      }),
      'packages/two/tsconfig.json': json({
        files: [],
        references: [{ path: '../shared/tsconfig.two.json' }],
      }),
    });

    try {
      await expect(
        resolveGeneratedGraphCheckers({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        }),
      ).rejects.toThrow(
        'Pending framework target has ambiguous effective membership',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps TypeScript-only auto scopes under tsc', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { sharedValue } from '../../shared/src/index';\nexport const value = sharedValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/shared/src/index.ts': 'export const sharedValue = 1;\n',
      'packages/shared/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });
    const analysis = createSpiedImportAnalysis();

    try {
      const result = await prepareGeneratedTsconfigGraph(
        {
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        },
        { importAnalysisContext: analysis.context },
      );

      expect(result.checkers).toMatchObject([
        {
          include: [
            'packages/app/tsconfig.json',
            'packages/shared/tsconfig.json',
          ],
          name: 'tsc',
        },
      ]);
      expect(Object.keys(result.manifest.checkers)).toEqual(['tsc']);
      expect(result.manifest.dependencyEdges).toMatchObject([
        {
          cacheReuse: 'reusable',
          fromChecker: 'tsc',
          kind: 'declaration-provider',
          toChecker: 'tsc',
        },
      ]);
      expect(analysis.resolveSupplementalImport).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps a query specifier out of Oxc ownership discovery without calling it a resource', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import './theme.css?inline';\nexport const value = true;\n",
      'packages/app/src/theme.css': ':root { color: red; }\n',
      'packages/app/tsconfig.json': json({ include: ['src/**/*.ts'] }),
    });
    const analysis = createSpiedImportAnalysis();

    try {
      await expect(
        resolveGeneratedGraphCheckers(
          {
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: { auto: {} },
            },
          },
          { importAnalysisContext: analysis.context },
        ),
      ).resolves.toMatchObject([
        { include: ['packages/app/tsconfig.json'], name: 'tsc' },
      ]);
      expect(analysis.resolveSupplementalImport).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    { ambient: true, specifier: '../../b/src/foo.ts?raw' },
    { ambient: false, specifier: '../../b/src/foo.ts?unknown' },
    { ambient: false, specifier: '../../b/src/foo.ts#fragment' },
  ])(
    'accepts only the checker result for $specifier (ambient=$ambient) and never recovers foo.ts',
    async ({ ambient, specifier }) => {
      const fixture = await createFixture({
        'packages/a/src/index.ts': `import raw from '${specifier}';\nexport const value = raw;\n`,
        ...(ambient && {
          'packages/a/src/env.d.ts': `declare module '*?raw' { const value: string; export default value; }
`,
        }),
        'packages/a/tsconfig.json': json({
          compilerOptions: managedOutputCompilerOptions(),
          include: ['src/**/*'],
        }),
        // The physical base file exists and is governed by another project.
        'packages/b/src/foo.ts': 'export const value = 1;\n',
        'packages/b/tsconfig.json': json({
          compilerOptions: managedOutputCompilerOptions(),
          include: ['src/**/*.ts'],
        }),
      });
      const analysis = createSpiedImportAnalysis();
      try {
        const result = await prepareGeneratedTsconfigGraph(
          {
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: { auto: {} },
            },
          },
          { importAnalysisContext: analysis.context },
        );
        expect(
          result.ownershipPlan.ownershipSelectionFacts!.filter(
            (fact) =>
              fact.consumerConfigPath ===
              fixture.path('packages/a/tsconfig.json'),
          ),
        ).toEqual([
          expect.objectContaining({
            importRecord: expect.objectContaining({ specifier }),
            physicalTargetPath: null,
            physicalTargetProvenance: null,
            referenceRequirement: null,
            typeEvidenceKind: 'unobserved',
          }),
        ]);
        expect(result.dependencyEdges).toEqual([]);
        expect(analysis.resolveSupplementalImport).not.toHaveBeenCalled();
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(
    ['svelte', 'vue', 'astro'].flatMap((extension) =>
      ['?x', `#part/../Widget.${extension}`].map((suffix) => ({
        extension,
        suffix,
      })),
    ),
  )(
    'does not rescue a $extension component with $suffix through Oxc or the filesystem',
    async ({ extension, suffix }) => {
      const fixture = await createFixture({
        'packages/consumer/src/index.ts': `import Widget from '../../provider/src/Widget.${extension}${suffix}';\nexport const value = Widget;\n`,
        'packages/consumer/tsconfig.json': json({
          compilerOptions: managedOutputCompilerOptions(),
          include: ['src/**/*.ts'],
        }),
        [`packages/provider/src/Widget.${extension}`]: '<div />',
        'packages/provider/tsconfig.json': json({
          compilerOptions: managedOutputCompilerOptions(),
          include: ['src/**/*'],
        }),
      });
      const analysis = createSpiedImportAnalysis();
      try {
        const result = await prepareGeneratedTsconfigGraph(
          {
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: { auto: {} },
            },
          },
          { importAnalysisContext: analysis.context },
        );
        expect(
          result.ownershipPlan.typeConfigs.get(
            fixture.path('packages/consumer/tsconfig.json'),
          )?.finalOwner,
        ).toBe('tsc');
        expect(
          result.ownershipPlan.ownershipSelectionFacts!.find(
            (fact) =>
              fact.consumerConfigPath ===
              fixture.path('packages/consumer/tsconfig.json'),
          ),
        ).toMatchObject({
          physicalTargetPath: null,
          physicalTargetProvenance: null,
          referenceRequirement: null,
          typeEvidenceKind: 'unobserved',
        });
        expect(result.dependencyEdges).toEqual([]);
        expect(analysis.resolveSupplementalImport).not.toHaveBeenCalled();
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(['../../b/src/theme.css', 'theme.css?raw', 'theme.css#fragment'])(
    'keeps a checker-proven compiler relation for %s regardless of runtime classification',
    async (specifier) => {
      const fixture = await createFixture({
        // TypeScript resolves every request to theme.css.ts. Runtime inspection
        // sees either a missing plain resource or unsupported query semantics.
        'packages/a/src/index.ts': `import { theme } from '${specifier}';\nexport const value = theme;\n`,
        'packages/a/tsconfig.json': json({
          compilerOptions: {
            ...managedOutputCompilerOptions(),
            paths: { [specifier]: ['../b/src/theme.css.ts'] },
          },
          include: ['src/**/*.ts'],
        }),
        'packages/b/src/theme.css.ts': 'export const theme = "dark";\n',
        'packages/b/tsconfig.json': json({
          compilerOptions: managedOutputCompilerOptions(),
          include: ['src/**/*.ts'],
        }),
      });
      const analysis = createSpiedImportAnalysis();
      try {
        const result = await prepareGeneratedTsconfigGraph(
          {
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: { auto: {} },
            },
          },
          { importAnalysisContext: analysis.context },
        );
        expect(
          result.ownershipPlan.dependencyFacts.find(
            (fact) =>
              fact.consumerConfigPath ===
              fixture.path('packages/a/tsconfig.json'),
          ),
        ).toMatchObject({
          physicalTargetPath: fixture.path('packages/b/src/theme.css.ts'),
          physicalTargetProvenance: 'checker-source',
          referenceRequirement: {
            kind: 'compiler-membership',
            targetFileName: fixture.path('packages/b/src/theme.css.ts'),
          },
        });
        expect(result.dependencyEdges).toMatchObject([
          {
            fromConfigPath: fixture.path('packages/a/tsconfig.json'),
            kind: 'declaration-provider',
            toConfigPath: fixture.path('packages/b/tsconfig.json'),
          },
        ]);
        expect(analysis.resolveSupplementalImport).not.toHaveBeenCalled();
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('rejects an Oxc ordinary TypeScript target as framework ownership evidence', async () => {
    const fixture = await createFixture({
      'packages/consumer/src/index.ts':
        "import './not-resolved-by-typescript';\nexport const value = true;\n",
      'packages/consumer/tsconfig.json': json({ include: ['src/**/*.ts'] }),
      'packages/vue/src/App.vue': '<template><div /></template>\n',
      'packages/vue/src/ordinary.ts': 'export const ordinary = true;\n',
      'packages/vue/tsconfig.json': json({ include: ['src/**/*'] }),
    });
    const base = createImportAnalysisContext();
    const ordinaryTarget = normalizeAbsolutePath(
      path.join(fixture.rootDir, 'packages/vue/src/ordinary.ts'),
    );
    const resolveOxcImport = vi.fn(
      (request: SupplementalResolutionRequest) => ({
        state: 'resolved' as const,
        target: ordinaryTarget,
        requestId: request.requestId,
        contextId: request.contextId,
        profile: 'test-ordinary-target',
        resolver: 'test-ordinary-target',
      }),
    );

    try {
      await expect(
        resolveGeneratedGraphCheckers(
          {
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: { auto: {} },
            },
          },
          {
            importAnalysisContext: {
              ...base,
              resolveSupplementalImport: resolveOxcImport,
            },
          },
        ),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            include: ['packages/consumer/tsconfig.json'],
            name: 'tsc',
          }),
          expect.objectContaining({
            include: ['packages/vue/tsconfig.json'],
            name: 'vue-tsc',
          }),
        ]),
      );
      expect(resolveOxcImport).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('classifies solution-style auto scopes from referenced leaves', async () => {
    const fixture = await createFixture({
      'packages/app/src/App.vue':
        '<script setup lang="ts">const value = 1;</script>\n',
      'packages/app/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/app/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          include: ['packages/app/tsconfig.json'],
          name: 'vue-tsc',
        },
      ]);
      expect(result.manifest.checkers['vue-tsc']?.sourceToDts).toMatchObject({
        'packages/app/tsconfig.lib.json':
          '.limina/tsconfig/checkers/vue-tsc/projects/packages/app/tsconfig.lib.dts.json',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('classifies an empty include solution from its checker-resolved file set', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': json({
        include: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/app/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });

      expect(result.manifest.checkers.tsc?.roots).toEqual([
        'packages/app/tsconfig.lib.json',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a named TypeScript solution reached through a default entry', async () => {
    const fixture = await createFixture({
      'packages/app/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.solution.json',
          },
        ],
      }),
      'packages/app/tsconfig.solution.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        }),
      ).rejects.toThrow('Source typecheck config declares project references');
    } finally {
      await fixture.cleanup();
    }
  });

  it('respects auto checker exclude for discovered entries', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/playground/src/index.ts': 'export const value = 1;\n',
      'packages/playground/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            auto: { exclude: ['packages/playground/tsconfig.json'] },
          },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          exclude: [],
          include: ['packages/app/tsconfig.json'],
          name: 'tsc',
        },
      ]);
      expect(result.manifest.checkers.tsc?.sourceToDts).toEqual({
        'packages/app/tsconfig.json':
          '.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.dts.json',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not apply auto checker entry exclude to solution references', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/test/index.ts': 'export const testValue = 1;\n',
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
          {
            path: './tsconfig.test.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/pkg/tsconfig.test.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['test/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            auto: { exclude: ['packages/pkg/tsconfig.test.json'] },
          },
        },
      });

      expect(result.manifest.checkers.tsc?.roots).toEqual([
        'packages/pkg/tsconfig.lib.json',
        'packages/pkg/tsconfig.test.json',
      ]);
      expect(result.manifest.checkers.tsc?.sourceToDts).toEqual({
        'packages/pkg/tsconfig.lib.json':
          '.limina/tsconfig/checkers/tsc/projects/packages/pkg/tsconfig.lib.dts.json',
        'packages/pkg/tsconfig.test.json':
          '.limina/tsconfig/checkers/tsc/projects/packages/pkg/tsconfig.test.dts.json',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps auto scopes whose referenced leaves match entry exclude', async () => {
    const fixture = await createFixture({
      'packages/pkg/test/index.ts': 'export const testValue = 1;\n',
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.test.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.test.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['test/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            auto: { exclude: ['packages/pkg/tsconfig.test.json'] },
          },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          include: ['packages/pkg/tsconfig.json'],
          name: 'tsc',
        },
      ]);
      expect(result.manifest.checkers.tsc?.roots).toEqual([
        'packages/pkg/tsconfig.test.json',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not exclude test configs in auto mode by default', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/test/index.ts': 'export const testValue = 1;\n',
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
          {
            path: './tsconfig.test.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/pkg/tsconfig.test.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['test/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {},
      });

      expect(result.manifest.checkers.tsc?.roots).toEqual([
        'packages/pkg/tsconfig.lib.json',
        'packages/pkg/tsconfig.test.json',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['astro', 'svelte'] as const)(
    'assigns pure .%s auto scopes to one framework owner',
    async (family) => {
      const fixture = await createFixture({
        [`packages/app/src/App.${family}`]:
          '<script lang="ts">const value = 1;</script>\n',
        'packages/app/tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*'],
        }),
      });
      const analysis = createSpiedImportAnalysis();

      try {
        const result = await prepareGeneratedTsconfigGraph(
          {
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: { auto: {} },
            },
          },
          { importAnalysisContext: analysis.context },
        );
        const sourceConfigPath = normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/app/tsconfig.json'),
        );

        const checkerName = family === 'astro' ? 'astro' : 'svelte-check';
        expect(result.checkers).toMatchObject([{ name: checkerName }]);
        expect(
          result.governedSources.get(checkerName)?.get(sourceConfigPath),
        ).toMatchObject({
          buildProjection: { kind: 'framework-checker' },
          frameworkCapabilities: [{ family, sourceConfigPath }],
          primaryCheckerName: checkerName,
        });
        expect(result.sourceToDts.get(checkerName)?.size ?? 0).toBe(0);
        expect(result.sourceToBuild.get(checkerName)?.size ?? 0).toBe(0);
        expect(analysis.resolveSupplementalImport).not.toHaveBeenCalled();
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('routes Astro files from an inherited effective include', async () => {
    const fixture = await createFixture({
      'packages/app/base.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
      }),
      'packages/app/src/App.astro':
        '<script lang="ts">const value = 1;</script>\n',
      'packages/app/tsconfig.json': json({
        extends: './base.json',
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });
      const sourceConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/app/tsconfig.json'),
      );

      expect(
        result.governedSources.get('astro')?.get(sourceConfigPath),
      ).toMatchObject({
        frameworkCapabilities: [{ family: 'astro', sourceConfigPath }],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('treats inherited Astro config identity as owner evidence', async () => {
    const fixture = await createFixture({
      'packages/app/base.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          plugins: [{ name: '@astrojs/ts-plugin' }],
          strict: true,
          target: 'ES2023',
          types: ['astro/client'],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': json({
        extends: './base.json',
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          include: ['packages/app/tsconfig.json'],
          name: 'astro',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails closed before classifying a missing generated extends', async () => {
    const fixture = await createFixture({
      'packages/app/tsconfig.json': json({
        extends: './.astro/tsconfigs/strict.json',
      }),
    });

    try {
      let thrown: unknown;
      try {
        await prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(LiminaStructuredError);
      expect(String(thrown)).toContain(
        'Unavailable auto checker extends config',
      );
      expect(String(thrown)).toContain('.astro/tsconfigs/strict.json');
      expect((thrown as LiminaStructuredError).issues).toMatchObject([
        {
          code: 'LIMINA_GRAPH_PREPARE_FAILED',
          title: 'Unavailable auto checker extends config',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('routes mixed TypeScript and Svelte roots through svelte-check only', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/src/App.svelte':
        '<script lang="ts">const value = 1;</script>\n',
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });
      const sourceConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/app/tsconfig.json'),
      );

      expect(
        result.governedSources.get('svelte-check')?.get(sourceConfigPath),
      ).toMatchObject({
        buildProjection: { kind: 'framework-checker' },
        frameworkCapabilities: [{ family: 'svelte', sourceConfigPath }],
        primaryCheckerName: 'svelte-check',
      });
      expect(result.sourceToDts.get('svelte-check')?.size ?? 0).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ['astro', 'svelte'],
    ['vue', 'astro'],
    ['vue', 'svelte'],
    ['vue', 'astro', 'svelte'],
  ] as const)(
    'rejects multiple framework root families in one type config: %s',
    async (...files) => {
      const sourceFiles = Object.fromEntries(
        files.map((extension) => [
          `packages/app/src/App.${extension}`,
          extension === 'vue'
            ? '<script setup lang="ts">const value = 1;</script>\n'
            : '<script lang="ts">const value = 1;</script>\n',
        ]),
      );
      const fixture = await createFixture({
        ...sourceFiles,
        'packages/app/tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*'],
        }),
      });

      try {
        await expect(
          prepareGeneratedTsconfigGraph({
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: { auto: {} },
            },
          }),
        ).rejects.toThrow(
          /Semantic authority conflict|generated graph preparation problems/u,
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(['astro', 'svelte'] as const)(
    'indexes pure .%s source ownership independently from declaration artifacts',
    async (family) => {
      const sourcePath = `packages/app/src/App.${family}`;
      const fixture = await createFixture({
        [sourcePath]: '<script lang="ts">const value = 1;</script>\n',
        'packages/app/tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*'],
        }),
      });

      try {
        const result = await prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        });
        const sourceConfigPath = normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/app/tsconfig.json'),
        );
        const checkerName = family === 'astro' ? 'astro' : 'svelte-check';
        const unit = result.governedSources
          .get(checkerName)
          ?.get(sourceConfigPath);

        expect(unit).toMatchObject({
          buildProjection: { kind: 'framework-checker' },
          configPath: sourceConfigPath,
          declarationFileNames: [],
          frameworkCapabilities: [
            {
              family,
              sourceConfigPath,
            },
          ],
          primaryCheckerName: checkerName,
        });
        expect(unit?.ownedFileNames).toEqual([
          normalizeAbsolutePath(path.join(fixture.rootDir, sourcePath)),
        ]);
        expect(
          result.sourceToDts.get(checkerName)?.has(sourceConfigPath) ?? false,
        ).toBe(false);
        expect(
          result.sourceToBuild.get(checkerName)?.has(sourceConfigPath) ?? false,
        ).toBe(false);
        expect(result.manifest.targets.framework).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              checker: checkerName,
              config: 'packages/app/tsconfig.json',
            }),
          ]),
        );
        expect(
          existsSync(
            path.join(
              fixture.rootDir,
              `.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.dts.json`,
            ),
          ),
        ).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([
    {
      checkerName: 'tsc',
      family: 'astro',
      nativeExtension: 'ts',
    },
    {
      checkerName: 'vue-tsc',
      family: 'astro',
      nativeExtension: 'vue',
    },
  ] as const)(
    'keeps explicit $checkerName ownership when .$family is outside its observation domain',
    async ({ checkerName, family, nativeExtension }) => {
      const fixture = await createFixture({
        [`packages/app/src/App.${family}`]: '<h1>Framework</h1>\n',
        [`packages/app/src/native.${nativeExtension}`]:
          nativeExtension === 'vue'
            ? '<script setup lang="ts">const value = 1;</script>\n'
            : 'export const value = 1;\n',
        'packages/app/tsconfig.json': json({
          compilerOptions: managedOutputCompilerOptions(),
          include: ['src/**/*'],
        }),
      });
      fixture.config.scope = {
        checkers: {
          [checkerName]: {
            include: ['packages/**/tsconfig.json'],
          },
        },
      };

      try {
        const result = await prepareGeneratedTsconfigGraph(fixture.config);
        expect(result.manifest.ownership.configs).toEqual([
          expect.objectContaining({
            config: 'packages/app/tsconfig.json',
            owner: checkerName,
          }),
        ]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('rejects combined Astro and Svelte root ownership', async () => {
    const fixture = await createFixture({
      'packages/app/src/App.astro': '<h1>Astro</h1>\n',
      'packages/app/src/App.svelte': '<h1>Svelte</h1>\n',
      'packages/app/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        }),
      ).rejects.toThrow('Semantic authority conflict');
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails closed when a framework source config declares application outputs', async () => {
    const fixture = await createFixture({
      'packages/app/src/App.astro': '<h1>Astro</h1>\n',
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
        liminaOptions: { outputs: {} },
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        }),
      ).rejects.toThrow('Limina only projects TypeScript declaration builds');
    } finally {
      await fixture.cleanup();
    }
  });

  // Real Astro declaration graphs exceeded 30s on Windows CI (up to 93s).
  it('records all cross-config imports from an Astro owner as scheduling edges', async () => {
    const fixture = await createFixture({
      'packages/a/src/App.astro': [
        '---',
        "import '../../c/src/index.ts';",
        "import '../../d/src/Widget.astro';",
        "import { getCollection } from 'astro:content';",
        "import './theme.css?inline';",
        "import hero from './hero.png?url';",
        'void [getCollection, hero];',
        '---',
        '<h1>Framework</h1>',
        '',
      ].join('\n'),
      'packages/a/src/index.ts':
        "import { value } from '../../b/src/index.ts';\nexport { value };\n",
      'packages/a/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
      }),
      'packages/b/src/index.ts': 'export const value = 1;\n',
      'packages/b/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
      'packages/c/src/index.ts': 'export const scheduled = 1;\n',
      'packages/c/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
      'packages/d/src/Widget.astro': '<h2>Widget</h2>\n',
      'packages/d/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });
      const sourceConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/a/tsconfig.json'),
      );
      const bConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/b/tsconfig.json'),
      );
      const cConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/c/tsconfig.json'),
      );
      const dConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/d/tsconfig.json'),
      );
      const unit = result.governedSources.get('astro')?.get(sourceConfigPath);

      expect(unit?.buildProjection.kind).toBe('framework-checker');
      expect([...unit!.declarationReferences]).toEqual([]);
      expect(result.dependencyEdges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromConfigPath: sourceConfigPath,
            kind: 'framework-schedule',
            toConfigPath: bConfigPath,
          }),
          expect.objectContaining({
            fromConfigPath: sourceConfigPath,
            kind: 'framework-schedule',
            toConfigPath: cConfigPath,
          }),
          expect.objectContaining({
            fromConfigPath: sourceConfigPath,
            kind: 'framework-schedule',
            toConfigPath: dConfigPath,
          }),
        ]),
      );
      const importedSpecifiers = result.dependencyEdges.map(
        ({ importedSpecifier }) => importedSpecifier,
      );
      expect(importedSpecifiers).not.toContain('astro:content');
      expect(importedSpecifiers).not.toContain('./theme.css?inline');
      expect(importedSpecifiers).not.toContain('./hero.png?url');
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  // Real Astro declaration graphs exceeded 30s on Windows CI (up to 93s).
  it('keeps Astro source authority while routing Astro, Svelte, Vue, and TypeScript targets through their owning policies', async () => {
    const fixture = await createFixture({
      'packages/a/src/App.astro': [
        '---',
        "import '../../astro-target/src/Widget.astro';",
        "import '../../svelte-target/src/Widget.svelte';",
        "import VueWidget from '../../vue-target/src/Widget.vue';",
        "import { direct } from '../../ts-target/src/index.ts';",
        'void [VueWidget, direct];',
        '---',
        '<h1>Astro owner</h1>',
        '',
      ].join('\n'),
      'packages/a/src/index.ts': 'export const app = true;\n',
      'packages/a/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
      }),
      'packages/astro-target/src/Widget.astro': '<h2>Astro</h2>\n',
      'packages/astro-target/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
      }),
      'packages/svelte-target/src/Widget.svelte': '<h2>Svelte</h2>\n',
      'packages/svelte-target/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
      }),
      'packages/vue-target/src/Widget.vue': [
        '<script setup lang="ts">',
        "import { nested } from '../../vue-provider/src/index.ts';",
        'void nested;',
        '</script>',
        '<template><div /></template>',
        '',
      ].join('\n'),
      'packages/vue-target/src/index.ts': 'export const widget = true;\n',
      'packages/vue-target/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
      }),
      'packages/vue-provider/src/index.ts': 'export const nested = true;\n',
      'packages/vue-provider/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
      'packages/ts-target/src/index.ts': 'export const direct = true;\n',
      'packages/ts-target/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });
      const configPath = (packageName: string) =>
        normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages', packageName, 'tsconfig.json'),
        );
      const aConfigPath = configPath('a');
      const astroConfigPath = configPath('astro-target');
      const svelteConfigPath = configPath('svelte-target');
      const vueConfigPath = configPath('vue-target');
      const vueProviderConfigPath = configPath('vue-provider');
      const tsConfigPath = configPath('ts-target');

      const frameworkRelationsMatcher = expect.arrayContaining([
        expect.objectContaining({
          file: expect.stringContaining('packages/a/src/App.astro:'),
          fromConfigPath: aConfigPath,
          importedSpecifier: '../../astro-target/src/Widget.astro',
          kind: 'framework-schedule',
          toConfigPath: astroConfigPath,
        }),
        expect.objectContaining({
          file: expect.stringContaining('packages/a/src/App.astro:'),
          fromConfigPath: aConfigPath,
          importedSpecifier: '../../svelte-target/src/Widget.svelte',
          kind: 'framework-schedule',
          toConfigPath: svelteConfigPath,
        }),
        expect.objectContaining({
          file: expect.stringContaining('packages/a/src/App.astro:'),
          fromConfigPath: aConfigPath,
          importedSpecifier: '../../vue-target/src/Widget.vue',
          kind: 'framework-schedule',
          toConfigPath: vueConfigPath,
        }),
        expect.objectContaining({
          file: expect.stringContaining('packages/a/src/App.astro:'),
          fromConfigPath: aConfigPath,
          importedSpecifier: '../../ts-target/src/index.ts',
          kind: 'framework-schedule',
          toConfigPath: tsConfigPath,
        }),
        expect.objectContaining({
          file: expect.stringContaining('packages/vue-target/src/Widget.vue:'),
          fromConfigPath: vueConfigPath,
          importedSpecifier: '../../vue-provider/src/index.ts',
          kind: 'declaration-provider',
          toConfigPath: vueProviderConfigPath,
        }),
      ]);
      expect(result.dependencyEdges).toEqual(frameworkRelationsMatcher);
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it('deduplicates one Astro execution failure without reporting a governance violation', async () => {
    const fixture = await createFixture(
      {
        'packages/app/src/App.astro': "---\nimport './target.ts';\n---\n",
        'packages/app/src/Page.astro': "---\nimport './target.ts';\n---\n",
        'packages/app/src/target.ts': 'export {};\n',
        'packages/app/tsconfig.json': json({
          compilerOptions: managedOutputCompilerOptions(),
          include: ['src/**/*'],
        }),
      },
      { astroToolchain: false },
    );
    const importAnalysis = createImportAnalysisContext();

    try {
      let thrown: unknown;
      try {
        await prepareGeneratedTsconfigGraph(
          {
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: { auto: {} },
            },
          },
          { importAnalysisContext: importAnalysis },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(LiminaStructuredError);
      expect(String(thrown)).toContain(
        'Missing Astro semantic toolchain dependency',
      );
      const analysis = (
        thrown as Error & { analysis: DependencyAnalysisResult }
      ).analysis;
      expect(analysis.outcome).toMatchObject({
        execution: 'partial',
        governance: { state: 'unavailable', diagnostics: [] },
        buildAdmission: { state: 'unavailable' },
      });
      expect(
        analysis.nativeEvidence
          ?.flatMap((entry) => entry.snapshot.failures)
          .filter((failure) =>
            failure.detail.includes(
              'Missing Astro semantic toolchain dependency',
            ),
          ),
      ).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('records Svelte imports of TypeScript providers and schedules component imports without treating resources or virtual modules as projects', async () => {
    const fixture = await createFixture({
      'packages/a/src/App.svelte': [
        '<script lang="ts">',
        "import Widget from '../../b/src/Widget.svelte';",
        "import { value } from '../../c/src/index.ts';",
        "import '$app/environment';",
        "import './theme.css?inline';",
        'void [Widget, value];',
        '</script>',
        '',
      ].join('\n'),
      'packages/a/src/index.ts': 'export const app = true;\n',
      'packages/a/src/framework-modules.d.ts': [
        "declare module '$app/environment';",
        "declare module '*.css?inline';",
        '',
      ].join('\n'),
      'packages/a/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
      }),
      'packages/b/src/Widget.svelte': [
        '<script lang="ts">',
        "import { value } from '../../c/src/index.ts';",
        'void value;',
        '</script>',
        '<h1>Widget</h1>',
        '',
      ].join('\n'),
      'packages/b/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
      }),
      'packages/c/src/index.ts': 'export const value = 1;\n',
      'packages/c/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });
      const aConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/a/tsconfig.json'),
      );
      const bConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/b/tsconfig.json'),
      );
      const cConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/c/tsconfig.json'),
      );
      const source = result.governedSources
        .get('svelte-check')
        ?.get(aConfigPath);

      expect(source?.buildProjection.kind).toBe('framework-checker');
      expect(result.ownershipPlan.dependencyFacts).toContainEqual(
        expect.objectContaining({
          consumerConfigPath: aConfigPath,
          importRecord: expect.objectContaining({
            specifier: '../../b/src/Widget.svelte',
          }),
          typeEvidenceKind: 'unobserved',
          referenceRequirement: {
            kind: 'source-semantic',
            targetFileName: fixture.path('packages/b/src/Widget.svelte'),
          },
        }),
      );
      expect(result.dependencyEdges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            importedSpecifier: '../../c/src/index.ts',
            kind: 'framework-schedule',
            toConfigPath: cConfigPath,
          }),
          expect.objectContaining({
            importedSpecifier: '../../b/src/Widget.svelte',
            kind: 'framework-schedule',
            toConfigPath: bConfigPath,
          }),
          expect.objectContaining({
            fromConfigPath: bConfigPath,
            importedSpecifier: '../../c/src/index.ts',
            kind: 'framework-schedule',
            toConfigPath: cConfigPath,
          }),
        ]),
      );
      expect(result.sourceToBuild.get('svelte-check')?.size ?? 0).toBe(0);
      expect(result.sourceToDts.get('svelte-check')?.size ?? 0).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails closed for unresolved local and generated-alias Svelte imports', async () => {
    const fixture = await createFixture({
      'packages/app/src/App.svelte': [
        '<script>',
        "import './missing.ts';",
        "import '$lib/missing';",
        '</script>',
        '',
      ].join('\n'),
      'packages/app/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        }),
      ).rejects.toThrow(
        /Unable to resolve framework source import:[\s\S]*\.\/missing\.ts[\s\S]*\$lib\/missing/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    {
      expected: 'Unable to load the Svelte semantic toolchain',
      file: '<h1>Missing compiler</h1>\n',
      svelteCompiler: false,
      svelteTransform: true,
    },
    {
      expected: 'package: svelte2tsx',
      file: '<h1>Missing transform</h1>\n',
      svelteCompiler: true,
      svelteTransform: false,
    },
    {
      expected: 'Svelte semantic service-script materialization failed',
      file: '<syntax-error>\n',
      svelteCompiler: true,
      svelteTransform: true,
    },
  ])(
    'retains independent evidence and separates Svelte execution failures from governance',
    async ({ expected, file, svelteCompiler, svelteTransform }) => {
      const fixture = await createFixture(
        {
          'packages/healthy/src/index.ts': 'import "./value"; export {};\n',
          'packages/healthy/src/value.ts': 'export const value = 1;\n',
          'packages/healthy/tsconfig.json': json({
            compilerOptions: managedOutputCompilerOptions(),
            include: ['src/**/*'],
          }),
          'packages/app/src/App.svelte': file,
          'packages/app/tsconfig.json': json({
            compilerOptions: managedOutputCompilerOptions(),
            include: ['src/**/*'],
          }),
        },
        { svelteCompiler, svelteTransform },
      );

      try {
        let thrown: unknown;
        try {
          await prepareGeneratedTsconfigGraph({
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: { auto: {} },
            },
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(LiminaStructuredError);
        expect(String(thrown)).toContain(expected);
        const analysis = (thrown as { analysis: DependencyAnalysisResult })
          .analysis;
        expect(analysis.outcome).toMatchObject({
          execution: 'partial',
          governance: { state: 'unavailable', diagnostics: [] },
          buildAdmission: { state: 'unavailable' },
        });
        expect(
          analysis.nativeEvidence?.flatMap((entry) => entry.snapshot.requests),
        ).toContainEqual(expect.objectContaining({ specifier: './value' }));
        expect(
          analysis.nativeEvidence?.flatMap((entry) => entry.snapshot.failures),
        ).toContainEqual(
          expect.objectContaining({
            detail: expect.stringContaining(expected),
            affected: expect.objectContaining({ kind: 'contexts' }),
          }),
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([
    { noResolve: false, script: 'ts', allowJs: false },
    { noResolve: true, script: 'ts', allowJs: false },
    { noResolve: false, script: 'js', allowJs: false },
    { noResolve: false, script: 'js', allowJs: true },
  ])(
    'qualifies a Pending Vue target without granting native loading ($script, noResolve=$noResolve, allowJs=$allowJs)',
    async ({ noResolve, script, allowJs }) => {
      const fixture = await createFixture({
        'packages/a/src/index.ts':
          "import { model } from '../../b/src/model'; import Button from '../../c/src/Button.vue'; export const result = { model, Button };",
        'packages/a/tsconfig.json': json({
          compilerOptions: {
            ...managedOutputCompilerOptions(),
            noResolve,
            allowJs,
          },
          include: ['src/**/*.ts'],
        }),
        'packages/b/src/model.ts': 'export const model = 1;',
        'packages/b/tsconfig.json': json({
          compilerOptions: managedOutputCompilerOptions(),
          include: ['src/**/*.ts'],
        }),
        'packages/c/src/Button.vue': `<script setup lang="${script}">const label = "hello";</script><template>{{ label }}</template>`,
        'packages/c/tsconfig.json': json({
          compilerOptions: { ...managedOutputCompilerOptions(), allowJs: true },
          include: ['src/**/*'],
        }),
      });
      const caches = createProjectDependencyCaches();
      const imports = createSpiedImportAnalysis();
      try {
        const result = await prepareGeneratedTsconfigGraph(
          {
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: { auto: {} },
            },
          },
          {
            projectDependencyCaches: caches,
            importAnalysisContext: imports.context,
          },
        );
        const pending = result.ownershipPlan.ownershipSelectionFacts?.find(
          (fact) => fact.importRecord.specifier.endsWith('Button.vue'),
        );
        expect(pending?.nativeEvidence?.obligation?.existence.state).toBe(
          'absent',
        );
        expect(pending?.supplementalDiscovery?.state).toBe('resolved');
        expect(
          imports.resolveSupplementalImport.mock.calls.some(([request]) =>
            request.specifier.endsWith('/model'),
          ),
        ).toBe(false);
        expect(
          caches.nativeSourceContexts?.get(
            fixture.path('packages/a/tsconfig.json'),
          )?.nativeInventory?.members,
        ).not.toContain(fixture.path('packages/c/src/Button.vue'));
        const locked = result.dependencyAnalysis!.supplementalAssessments![0]!;
        expect(locked.context.id).not.toBe(
          pending?.supplementalAssessment?.context.id,
        );
        expect(
          projectSupplementalPrerequisite(
            locked,
            result.dependencyAnalysis!.candidate!,
          ),
        ).toBeDefined();
        expect(
          projectSupplementalPrerequisite(
            structuredClone(locked),
            result.dependencyAnalysis!.candidate!,
          ),
        ).toBeUndefined();

        expect(
          pending?.supplementalAssessment?.obligation.existence,
          JSON.stringify(pending?.supplementalAssessment?.obligation),
        ).toMatchObject({
          state:
            noResolve || (script === 'js' && !allowJs) ? 'absent' : 'present',
        });
        const snapshot = result.dependencyAnalysis?.nativeEvidence
          ?.map((item) => item.snapshot)
          .find((value) =>
            value.contexts.some(
              (context) =>
                context.authority.phase === 'pending' &&
                context.inputs.config ===
                  fixture.path('packages/a/tsconfig.json'),
            ),
          );
        expect(
          snapshot?.resolutions.find(
            (value) => value.requestId === pending?.nativeEvidence?.requestId,
          ),
        ).toMatchObject({ state: 'unresolved', target: null });
        expect(
          result.dependencyEdges.some(
            (edge) =>
              edge.fromConfigPath ===
                fixture.path('packages/a/tsconfig.json') &&
              edge.toConfigPath === fixture.path('packages/c/tsconfig.json'),
          ),
        ).toBe(!noResolve && (script === 'ts' || allowJs));
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('uses an untyped Svelte import for pending ownership without admitting the Oxc bootstrap as a final edge', async () => {
    const fixture = await createFixture({
      'packages/a/src/index.ts':
        "import '../../b/src/App.svelte';\nexport const value = 1;\n",
      'packages/a/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
      'packages/b/src/App.svelte': '<h1>Svelte</h1>\n',
      'packages/b/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*'],
      }),
    });
    const analysis = createSpiedImportAnalysis();

    try {
      const result = await prepareGeneratedTsconfigGraph(
        {
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: { auto: {} },
          },
        },
        { importAnalysisContext: analysis.context },
      );
      expect(result.checkers).toMatchObject([
        {
          include: ['packages/a/tsconfig.json', 'packages/b/tsconfig.json'],
          name: 'svelte-check',
        },
      ]);
      expect(result.dependencyEdges).toEqual([]);
      expect(analysis.resolveSupplementalImport).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes a manifest and generated declaration leaf for source configs', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        liminaOptions: {
          graphRules: ['runtime'],
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      const sourcePath = 'packages/pkg/tsconfig.lib.json';
      const dtsPath =
        '.limina/tsconfig/checkers/tsc/projects/packages/pkg/tsconfig.lib.dts.json';

      expect(toPortablePath(result.manifestPath)).toBe(
        toPortablePath(path.join(fixture.rootDir, '.limina/manifest.json')),
      );
      expect(result.manifest.checkers.tsc?.sourceToDts).toMatchObject({
        [sourcePath]: dtsPath,
      });
      expect(result.manifest.checkers.tsc?.dtsToSource).toMatchObject({
        [dtsPath]: sourcePath,
      });

      const generatedConfig = JSON.parse(
        await readFile(path.join(fixture.rootDir, dtsPath), 'utf8'),
      ) as {
        compilerOptions: Record<string, unknown>;
        extends: string[];
        files: string[];
        include: unknown[];
        liminaOptions: Record<string, unknown>;
      };

      expect(generatedConfig.compilerOptions.composite).toBe(true);
      expect(generatedConfig.compilerOptions.emitDeclarationOnly).toBe(true);
      const relativeSourceConfig = path.relative(
        path.dirname(path.join(fixture.rootDir, dtsPath)),
        path.join(fixture.rootDir, sourcePath),
      );
      const expectedSourceConfigReference =
        toPortablePath(relativeSourceConfig);
      expect(generatedConfig.extends).toEqual([expectedSourceConfigReference]);
      const relativeRootFile = path.relative(
        path.dirname(path.join(fixture.rootDir, dtsPath)),
        path.join(fixture.rootDir, 'packages/pkg/src/index.ts'),
      );
      const expectedRootFile = toPortablePath(relativeRootFile);
      expect(generatedConfig.files).toEqual([expectedRootFile]);
      expect(generatedConfig.include).toEqual([]);
      expect(generatedConfig.liminaOptions).toMatchObject({
        checker: 'tsc',
        generated: true,
        graphRules: ['runtime'],
      });
      expect(generatedConfig.liminaOptions.sourceConfig).toContain(
        'packages/pkg/tsconfig.lib.json',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('overrides direct and inherited declarationDir in generated declaration projects', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.base.json': json({
        compilerOptions: {
          declarationDir: './legacy-declarations',
          outDir: './legacy-output',
        },
      }),
      'packages/pkg/tsconfig.mid.json': json({
        extends: './tsconfig.base.json',
        compilerOptions: {
          declarationDir: './mid-declarations',
        },
      }),
      'packages/pkg/tsconfig.json': json({
        extends: './tsconfig.mid.json',
        files: [],
        references: [{ path: './tsconfig.lib.json' }],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        extends: './tsconfig.mid.json',
        compilerOptions: {
          declarationDir: './leaf-declarations',
          outDir: './leaf-output',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      const sourceConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/pkg/tsconfig.lib.json'),
      );
      const generatedConfigPath = result.sourceToDts
        .get('tsc')
        ?.get(sourceConfigPath);

      expect(generatedConfigPath).toBeDefined();
      const parsed = parseProject(fixture.config, generatedConfigPath!);
      const generatedRoot = normalizeAbsolutePath(
        path.join(
          fixture.rootDir,
          '.limina/dts/checkers/tsc/packages/pkg/tsconfig.lib.json',
        ),
      );

      expect(parsed.options.outDir).toBe(generatedRoot);
      expect(parsed.options.declarationDir).toBe(generatedRoot);
      expect(parsed.options.outDir).not.toBe(
        normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/pkg/leaf-output'),
        ),
      );
      expect(parsed.options.declarationDir).not.toBe(
        normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/pkg/leaf-declarations'),
        ),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('emits the managed declaration root for a leaf direct declarationDir', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          declarationDir: './legacy-declarations',
          outDir: './legacy-output',
          ...managedOutputCompilerOptions(),
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      const sourceConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/pkg/tsconfig.json'),
      );
      const generatedConfigPath = result.sourceToDts
        .get('tsc')
        ?.get(sourceConfigPath);
      expect(generatedConfigPath).toBeDefined();

      const parsed = parseProject(fixture.config, generatedConfigPath!);
      const generatedRoot = normalizeAbsolutePath(
        path.join(
          fixture.rootDir,
          '.limina/dts/checkers/tsc/packages/pkg/tsconfig.json',
        ),
      );
      expect(parsed.options.outDir).toBe(generatedRoot);
      expect(parsed.options.declarationDir).toBe(generatedRoot);
    } finally {
      await fixture.cleanup();
    }
  });

  it('emits the managed declaration root for a leaf inheriting declarationDir from its base', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.base.json': json({
        compilerOptions: { declarationDir: './legacy-declarations' },
      }),
      'packages/pkg/tsconfig.json': json({
        extends: './tsconfig.base.json',
        compilerOptions: {
          outDir: './legacy-output',
          ...managedOutputCompilerOptions(),
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      const generatedConfigPath = result.sourceToDts
        .get('tsc')
        ?.get(
          normalizeAbsolutePath(
            path.join(fixture.rootDir, 'packages/pkg/tsconfig.json'),
          ),
        );
      expect(generatedConfigPath).toBeDefined();
      const parsed = parseProject(fixture.config, generatedConfigPath!);
      expect(parsed.options.outDir).toBe(parsed.options.declarationDir);
      expect(parsed.options.declarationDir).toContain(
        normalizeAbsolutePath(path.join(fixture.rootDir, '.limina/dts')),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('emits the managed declaration root for multi-level inherited declarationDir', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.base.json': json({
        compilerOptions: { declarationDir: './legacy-declarations' },
      }),
      'packages/pkg/tsconfig.mid.json': json({
        extends: './tsconfig.base.json',
      }),
      'packages/pkg/tsconfig.json': json({
        extends: './tsconfig.mid.json',
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      const generatedConfigPath = result.sourceToDts
        .get('tsc')
        ?.get(
          normalizeAbsolutePath(
            path.join(fixture.rootDir, 'packages/pkg/tsconfig.json'),
          ),
        );
      expect(generatedConfigPath).toBeDefined();
      const parsed = parseProject(fixture.config, generatedConfigPath!);
      expect(parsed.options.outDir).toBe(parsed.options.declarationDir);
      expect(parsed.options.declarationDir).toContain(
        normalizeAbsolutePath(path.join(fixture.rootDir, '.limina/dts')),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes managed declarations when source configs inherit declarationDir', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.base.json': json({
        compilerOptions: { declarationDir: './legacy-declarations' },
      }),
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [{ path: './tsconfig.lib.json' }],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        extends: './tsconfig.base.json',
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          outDir: './legacy-output',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      const generatedConfigPath = result.sourceToDts
        .get('tsc')
        ?.get(
          normalizeAbsolutePath(
            path.join(fixture.rootDir, 'packages/pkg/tsconfig.lib.json'),
          ),
        );
      expect(generatedConfigPath).toBeDefined();

      await execFileAsync(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../node_modules/typescript/bin/tsc', import.meta.url),
          ),
          '-b',
          '--pretty',
          'false',
          generatedConfigPath!,
        ],
        { cwd: fixture.rootDir },
      );

      const managedDeclaration = path.join(
        fixture.rootDir,
        '.limina/dts/checkers/tsc/packages/pkg/tsconfig.lib.json/index.d.ts',
      );
      expect(existsSync(managedDeclaration)).toBe(true);
      expect(
        existsSync(
          path.join(
            fixture.rootDir,
            'packages/pkg/legacy-declarations/src/index.d.ts',
          ),
        ),
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('generates per-package Knip tsconfig entries from static package build scripts', async () => {
    const fixture = await createFixture(
      {
        'package.json': json({
          name: '@example/root',
          private: true,
          workspaces: ['packages/*'],
        }),
        'packages/pkg/package.json': json({
          name: '@example/pkg',
          scripts: {
            build: 'limina build tsconfig.json',
          },
          type: 'module',
        }),
        'packages/pkg/src/index.ts': 'export const value = 1;\n',
        'packages/pkg/tsconfig.json': json({
          files: [],
          references: [
            {
              path: './tsconfig.lib.json',
            },
          ],
        }),
        'packages/pkg/tsconfig.lib.json': json({
          liminaOptions: {
            outputs: {},
          },
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      },
      { source: { knip: true } },
    );

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      const generatedPath = '.limina/knip/packages/pkg/tsconfig.knip.json';
      const generatedConfig = JSON.parse(
        await readFile(path.join(fixture.rootDir, generatedPath), 'utf8'),
      ) as {
        files?: unknown[];
        include?: unknown;
        references?: { path: string }[];
      };

      expect(generatedConfig.files).toEqual([]);
      expect(generatedConfig.include).toBeUndefined();
      expect(generatedConfig.references).toEqual([
        {
          path: '../../../tsconfig/checkers/tsc/outputs/solutions/packages/pkg/tsconfig.output.json',
        },
      ]);
      expect(result.manifest.knip.packages).toEqual([
        {
          configPath: generatedPath,
          packageDirectory: 'packages/pkg',
          packageJsonPath: 'packages/pkg/package.json',
          packageName: '@example/pkg',
          references: [
            '.limina/tsconfig/checkers/tsc/outputs/solutions/packages/pkg/tsconfig.output.json',
          ],
          scripts: [
            {
              command: 'limina build tsconfig.json',
              configPath: 'packages/pkg/tsconfig.json',
              mode: 'managed',
              name: 'build',
            },
          ],
        },
      ]);
      expect(
        toPortablePath(result.generatedKnipConfigs[0]?.configPath ?? ''),
      ).toBe(toPortablePath(path.join(fixture.rootDir, generatedPath)));
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts watch flags in static package build scripts', async () => {
    const fixture = await createFixture(
      {
        'package.json': json({
          name: '@example/root',
          private: true,
          workspaces: ['packages/*'],
        }),
        'packages/pkg/package.json': json({
          name: '@example/pkg',
          scripts: {
            'build:watch': 'limina build tsconfig.json --preset tsc -w',
          },
          type: 'module',
        }),
        'packages/pkg/src/index.ts': 'export const value = 1;\n',
        'packages/pkg/tsconfig.json': json({
          files: [],
          references: [
            {
              path: './tsconfig.lib.json',
            },
          ],
        }),
        'packages/pkg/tsconfig.lib.json': json({
          liminaOptions: {
            outputs: {},
          },
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      },
      { source: { knip: { workspaces: {} } } },
    );

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);

      expect(result.manifest.knip.diagnostics).toEqual([]);
      expect(result.manifest.knip.packages).toEqual([
        expect.objectContaining({
          references: [
            '.limina/tsconfig/checkers/tsc/outputs/solutions/packages/pkg/tsconfig.output.json',
          ],
          scripts: [
            {
              checker: 'tsc',
              command: 'limina build tsconfig.json --preset tsc -w',
              configPath: 'packages/pkg/tsconfig.json',
              mode: 'managed',
              name: 'build:watch',
            },
          ],
        }),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores global checker build package scripts without Knip config sources', async () => {
    const fixture = await createFixture({
      'package.json': json({
        name: '@example/root',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/pkg/package.json': json({
        name: '@example/pkg',
        scripts: {
          typecheck: 'limina checker build',
        },
        type: 'module',
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);

      expect(result.manifest.knip.packages).toEqual([]);
      expect(result.manifest.knip.diagnostics).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    { name: 'omitted', source: undefined },
    { name: 'false', source: { knip: false } },
  ])('does not prepare Knip metadata when $name', async ({ source }) => {
    const fixture = await createFixture(
      {
        'package.json': json({
          name: '@example/root',
          private: true,
          workspaces: ['packages/*'],
        }),
        'packages/pkg/package.json': json({
          name: '@example/pkg',
          scripts: {
            build: 'limina build tsconfig.json',
          },
          type: 'module',
        }),
        'packages/pkg/src/index.ts': 'export const value = 1;\n',
        'packages/pkg/tsconfig.json': json({
          files: [],
          references: [{ path: './tsconfig.lib.json' }],
        }),
        'packages/pkg/tsconfig.lib.json': json({
          liminaOptions: { outputs: {} },
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      },
      source === undefined ? {} : { source },
    );

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);

      expect(result.generatedKnipConfigs).toEqual([]);
      expect(result.generatedKnipDiagnostics).toEqual([]);
      expect(result.manifest.knip).toEqual({
        diagnostics: [],
        packages: [],
      });
      expect(
        existsSync(
          path.join(
            fixture.rootDir,
            '.limina/knip/packages/pkg/tsconfig.knip.json',
          ),
        ),
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('removes previously owned Knip files after disabling the feature', async () => {
    const fixture = await createFixture(
      {
        'package.json': json({
          name: '@example/root',
          private: true,
          workspaces: ['packages/*'],
        }),
        'packages/pkg/package.json': json({
          name: '@example/pkg',
          scripts: {
            build: 'limina build tsconfig.json',
          },
          type: 'module',
        }),
        'packages/pkg/src/index.ts': 'export const value = 1;\n',
        'packages/pkg/tsconfig.json': json({
          files: [],
          references: [{ path: './tsconfig.lib.json' }],
        }),
        'packages/pkg/tsconfig.lib.json': json({
          liminaOptions: { outputs: {} },
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      },
      { source: { knip: true } },
    );
    const generatedPath = path.join(
      fixture.rootDir,
      '.limina/knip/packages/pkg/tsconfig.knip.json',
    );

    try {
      await prepareGeneratedTsconfigGraph(fixture.config);
      expect(existsSync(generatedPath)).toBe(true);

      fixture.config.source = { knip: false };
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      expect(result.manifest.knip).toEqual({
        diagnostics: [],
        packages: [],
      });
      expect(existsSync(generatedPath)).toBe(false);
      expect(result.manifest.ownedArtifacts).not.toContain(
        '.limina/knip/packages/pkg/tsconfig.knip.json',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('records diagnostics for dynamic package build scripts without generating Knip configs', async () => {
    const fixture = await createFixture(
      {
        'package.json': json({
          name: '@example/root',
          private: true,
          workspaces: ['packages/*'],
        }),
        'packages/pkg/package.json': json({
          name: '@example/pkg',
          scripts: {
            build: 'limina build $CONFIG',
          },
          type: 'module',
        }),
      },
      { source: { knip: true } },
    );

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);

      expect(result.manifest.knip.packages).toEqual([]);
      expect(result.manifest.knip.diagnostics).toEqual([
        expect.objectContaining({
          command: 'limina build $CONFIG',
          packageJsonPath: 'packages/pkg/package.json',
          packageName: '@example/pkg',
          scriptName: 'build',
        }),
      ]);
      expect(result.manifest.knip.diagnostics[0]?.reason).toContain(
        'static limina build scripts',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('records diagnostics for unsupported package build scripts without generating Knip configs', async () => {
    const fixture = await createFixture(
      {
        'package.json': json({
          name: '@example/root',
          private: true,
          workspaces: ['packages/*'],
        }),
        'packages/pkg/package.json': json({
          name: '@example/pkg',
          scripts: {
            build: 'pnpm run limina build tsconfig.json',
            'build:checker': 'limina build tsconfig.json --checker tsgo',
          },
          type: 'module',
        }),
      },
      { source: { knip: true } },
    );

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);

      expect(result.manifest.knip.packages).toEqual([]);
      expect(result.manifest.knip.diagnostics).toEqual([
        expect.objectContaining({
          command: 'pnpm run limina build tsconfig.json',
          packageName: '@example/pkg',
          scriptName: 'build',
        }),
        expect.objectContaining({
          command: 'limina build tsconfig.json --checker tsgo',
          packageName: '@example/pkg',
          reason:
            'Limina build script analysis only supports --raw, --preset, -w/--watch, plus one literal config argument.',
          scriptName: 'build:checker',
        }),
      ]);
      expect(result.manifest.knip.diagnostics[0]?.reason).toContain(
        'direct limina build',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('records diagnostics for raw package build scripts that leave the package owner', async () => {
    const fixture = await createFixture(
      {
        'package.json': json({
          name: '@example/root',
          private: true,
          workspaces: ['packages/*'],
        }),
        'packages/app/package.json': json({
          name: '@example/app',
          scripts: {
            build:
              'limina build ../internal/tsconfig.raw.json --raw --preset tsc',
          },
          type: 'module',
        }),
        'packages/internal/package.json': json({
          name: '@example/internal',
          type: 'module',
        }),
        'packages/internal/tsconfig.raw.json': json({
          include: ['src/**/*.ts'],
        }),
      },
      { source: { knip: true } },
    );

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);

      expect(result.manifest.knip.packages).toEqual([]);
      expect(result.manifest.knip.diagnostics[0]).toMatchObject({
        command:
          'limina build ../internal/tsconfig.raw.json --raw --preset tsc',
        packageJsonPath: 'packages/app/package.json',
        packageName: '@example/app',
        scriptName: 'build',
      });
      expect(result.manifest.knip.diagnostics[0]?.reason).toContain(
        'raw build configs from package scripts must resolve inside the owning package directory',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('generates explicit output project configs with inherited explicit source target', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.base.json': json({
        compilerOptions: {
          target: 'ES2022',
        },
      }),
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        extends: './tsconfig.base.json',
        liminaOptions: {
          outputs: {
            outDir: './dist',
            rootDir: './src',
          },
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      const sourcePath = 'packages/pkg/tsconfig.lib.json';
      const outputPath =
        '.limina/tsconfig/checkers/tsc/outputs/projects/packages/pkg/tsconfig.lib.output.json';
      const outputConfigPath = path.join(fixture.rootDir, outputPath);
      const outputConfig = JSON.parse(
        await readFile(outputConfigPath, 'utf8'),
      ) as {
        compilerOptions: Record<string, unknown>;
        extends: string[];
        files: string[];
        include: unknown[];
        liminaOptions: Record<string, unknown>;
        references?: { path: string }[];
      };

      expect(result.manifest.version).toBe(6);
      expect(result.manifest.checkers.tsc?.configToOutputBuild).toMatchObject({
        [sourcePath]: {
          kind: 'project',
          path: outputPath,
        },
      });
      const expectedDeclarationDirectory = toPortablePath(
        path.relative(
          path.dirname(outputConfigPath),
          path.join(fixture.rootDir, 'packages/pkg/dist'),
        ),
      );
      const expectedOutputDirectory = toPortablePath(
        path.relative(
          path.dirname(outputConfigPath),
          path.join(fixture.rootDir, 'packages/pkg/dist'),
        ),
      );
      const expectedRootDirectory = toPortablePath(
        path.relative(
          path.dirname(outputConfigPath),
          path.join(fixture.rootDir, 'packages/pkg/src'),
        ),
      );
      const expectedBuildInfoPath = toPortablePath(
        path.relative(
          path.dirname(outputConfigPath),
          path.join(
            fixture.rootDir,
            '.limina/tsbuildinfo/build/packages/pkg/tsconfig.lib.json.tsbuildinfo',
          ),
        ),
      );
      expect(outputConfig.compilerOptions).toMatchObject({
        composite: true,
        declaration: true,
        declarationMap: false,
        declarationDir: expectedDeclarationDirectory,
        emitDeclarationOnly: false,
        incremental: true,
        noEmit: false,
        outDir: expectedOutputDirectory,
        rootDir: expectedRootDirectory,
        target: 'ES2022',
        tsBuildInfoFile: expectedBuildInfoPath,
      });
      expect(outputConfig.compilerOptions.declarationDir).toBe(
        outputConfig.compilerOptions.outDir,
      );
      const expectedSourceConfigReference = toPortablePath(
        path.relative(
          path.dirname(outputConfigPath),
          path.join(fixture.rootDir, sourcePath),
        ),
      );
      expect(outputConfig.extends).toEqual([expectedSourceConfigReference]);
      const expectedRootFile = toPortablePath(
        path.relative(
          path.dirname(outputConfigPath),
          path.join(fixture.rootDir, 'packages/pkg/src/index.ts'),
        ),
      );
      expect(outputConfig.files).toEqual([expectedRootFile]);
      expect(outputConfig.include).toEqual([]);
      expect(outputConfig.references).toEqual([]);
      const expectedLiminaSourceConfig = toPortablePath(
        path.relative(
          path.dirname(outputConfigPath),
          path.join(fixture.rootDir, sourcePath),
        ),
      );
      expect(outputConfig.liminaOptions.sourceConfig).toBe(
        expectedLiminaSourceConfig,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps generated project root files fixed to the generation snapshot', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await prepareGeneratedTsconfigGraph(fixture.config);
      await writeText(
        path.join(fixture.rootDir, 'packages/pkg/src/late.ts'),
        'export const late = true;\n',
      );

      const sourceConfigPath = path.join(
        fixture.rootDir,
        'packages/pkg/tsconfig.lib.json',
      );
      const dtsConfigPath = path.join(
        fixture.rootDir,
        '.limina/tsconfig/checkers/tsc/projects/packages/pkg/tsconfig.lib.dts.json',
      );
      const outputConfigPath = path.join(
        fixture.rootDir,
        '.limina/tsconfig/checkers/tsc/outputs/projects/packages/pkg/tsconfig.lib.output.json',
      );
      const toFixturePaths = (fileNames: string[]): string[] =>
        fileNames
          .map((fileName) =>
            toPortablePath(path.relative(fixture.rootDir, fileName)),
          )
          .sort((left, right) => Number(left > right) - Number(left < right));

      expect(
        toFixturePaths(
          parseProject(fixture.config, sourceConfigPath).fileNames,
        ),
      ).toEqual(['packages/pkg/src/index.ts', 'packages/pkg/src/late.ts']);
      expect(
        toFixturePaths(parseProject(fixture.config, dtsConfigPath).fileNames),
      ).toEqual(['packages/pkg/src/index.ts']);
      expect(
        toFixturePaths(
          parseProject(fixture.config, outputConfigPath).fileNames,
        ),
      ).toEqual(['packages/pkg/src/index.ts']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects user-managed output build info files', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        liminaOptions: {
          outputs: {
            tsBuildInfoFile: './dist/.tsbuildinfo',
          },
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow('liminaOptions.outputs.tsBuildInfoFile');
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow(
        'outputs only supports target, rootDir, outDir, and declarationMap',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('generates output project configs with declaration maps when requested', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        liminaOptions: {
          outputs: {
            declarationMap: true,
          },
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await prepareGeneratedTsconfigGraph(fixture.config);
      const outputPath =
        '.limina/tsconfig/checkers/tsc/outputs/projects/packages/pkg/tsconfig.lib.output.json';
      const outputConfig = JSON.parse(
        await readFile(path.join(fixture.rootDir, outputPath), 'utf8'),
      ) as {
        compilerOptions: Record<string, unknown>;
      };

      expect(outputConfig.compilerOptions.declarationMap).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('exposes output declaration copy contexts without persisting them in the manifest', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/src/vite-env.d.ts':
        '/// <reference types="vite/client" />\n',
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        liminaOptions: {
          outputs: {
            outDir: './dist',
            rootDir: './src',
          },
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts', 'src/**/*.d.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      const sourceConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/pkg/tsconfig.lib.json'),
      );
      const copyContexts = result.outputDeclarationCopies
        .get('tsc')
        ?.get(sourceConfigPath);

      expect(copyContexts).toHaveLength(1);
      expect(copyContexts?.[0]).toMatchObject({
        outDir: normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/pkg/dist'),
        ),
        rootDir: normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/pkg/src'),
        ),
        sourceConfigPath,
      });
      expect(
        copyContexts?.[0]?.fileNames.map((fileName) =>
          toPortablePath(path.relative(fixture.rootDir, fileName)),
        ),
      ).toContain('packages/pkg/src/vite-env.d.ts');
      expect(JSON.stringify(result.manifest)).not.toContain(
        'outputDeclarationCopies',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('generates flattened output solution configs for output-enabled leaves', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/test/index.ts': 'export const testValue = 1;\n',
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
          {
            path: './tsconfig.test.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/pkg/tsconfig.test.json': json({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['test/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      const solutionPath =
        '.limina/tsconfig/checkers/tsc/outputs/solutions/packages/pkg/tsconfig.output.json';
      const solutionConfig = JSON.parse(
        await readFile(path.join(fixture.rootDir, solutionPath), 'utf8'),
      ) as {
        references: { path: string }[];
      };

      expect(result.manifest.checkers.tsc?.configToOutputBuild).toMatchObject({
        'packages/pkg/tsconfig.json': {
          kind: 'solution',
          path: solutionPath,
        },
      });
      expect(solutionConfig.references).toEqual([
        {
          path: '../../../projects/packages/pkg/tsconfig.lib.output.json',
        },
        {
          path: '../../../projects/packages/pkg/tsconfig.test.output.json',
        },
      ]);
      expect(JSON.stringify(solutionConfig)).not.toContain('.dts.json');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects multiple output build owners for shared output source configs', async () => {
    const fixture = await createFixture({
      'packages/one/tsconfig.json': json({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/two/tsconfig.json': json({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/shared/src/index.ts': 'export const value = 1;\n',
      'packages/shared/tsconfig.lib.json': json({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      let thrown: unknown;

      try {
        await prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsgo: {
                include: ['packages/one/tsconfig.json'],
              },
              tsc: {
                include: ['packages/two/tsconfig.json'],
              },
            },
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(String(thrown)).toContain('Checker ownership conflict');
      expect(String(thrown)).toContain('packages/shared/tsconfig.lib.json');
      expect(String(thrown)).toContain('checker: tsc');
      expect(String(thrown)).toContain('checker: tsgo');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects output build owner collisions independent of checker engine', async () => {
    const fixture = await createFixture({
      'packages/one/tsconfig.json': json({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/two/tsconfig.json': json({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/shared/src/index.ts': 'export const value = 1;\n',
      'packages/shared/tsconfig.lib.json': json({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: ['packages/one/tsconfig.json'],
              },
              tsgo: {
                include: ['packages/two/tsconfig.json'],
              },
            },
          },
        }),
      ).rejects.toThrow('Checker ownership conflict');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects invalid output options and outputs on solution configs', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        files: [],
        liminaOptions: {
          outputs: {},
        },
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        liminaOptions: {
          outputs: {
            declarationMap: 'true',
            unexpected: 'value',
          },
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow(
        'liminaOptions.outputs is only allowed on ordinary source leaf configs',
      );
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow('liminaOptions.outputs.unexpected');
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow('liminaOptions.outputs.declarationMap');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects output-enabled managed project references without dependency outputs', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { coreValue } from '../../core/src/index';\nexport const value = coreValue;\n",
      'packages/app/tsconfig.json': json({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/core/src/index.ts': 'export const coreValue = 1;\n',
      'packages/core/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: [
                  'packages/app/tsconfig.json',
                  'packages/core/tsconfig.json',
                ],
              },
            },
          },
        }),
      ).rejects.toThrow(
        'Missing Limina output options for referenced source project',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('requires outputs on policy providers of an output-enabled consumer', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { coreValue } from '../../core/src/index';\nexport const value = coreValue;\n",
      'packages/app/tsconfig.json': json({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/core/src/index.d.ts':
        'export declare const coreValue: number;\n',
      'packages/core/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.d.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: [
                  'packages/app/tsconfig.json',
                  'packages/core/tsconfig.json',
                ],
              },
            },
          },
        }),
      ).rejects.toThrow(
        'Missing Limina output options for referenced source project',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects checker include patterns that match non-entry tsconfig files', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        include: ['src/**/*.ts'],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: ['packages/**/tsconfig*.json'],
              },
            },
          },
        }),
      ).rejects.toThrow('Checker include matched non-entry tsconfig files');
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores isolated non-standard tsconfig files that no entry references', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/pkg/tsconfig.build.json': json({
        include: ['src/**/*.ts'],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);

      expect(result.manifest.checkers.tsc?.sourceToDts).toEqual({
        'packages/pkg/tsconfig.json':
          '.limina/tsconfig/checkers/tsc/projects/packages/pkg/tsconfig.dts.json',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('treats selected typecheck tsconfig.json files as declaration leaves', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: ['packages/pkg/tsconfig.json'],
            },
          },
        },
      });

      expect(result.manifest.checkers.tsc?.roots).toEqual([
        'packages/pkg/tsconfig.json',
      ]);
      expect(result.manifest.checkers.tsc?.sourceToDts).toMatchObject({
        'packages/pkg/tsconfig.json':
          '.limina/tsconfig/checkers/tsc/projects/packages/pkg/tsconfig.dts.json',
      });
      expect(result.manifest.checkers.tsc?.sourceToBuild).toMatchObject({
        'packages/pkg/tsconfig.json': {
          kind: 'project',
          path: '.limina/tsconfig/checkers/tsc/projects/packages/pkg/tsconfig.dts.json',
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('expands selected solution tsconfig references into generated declaration leaves', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/test/index.ts': 'export const testValue = 1;\n',
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
          {
            path: './tsconfig.test.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/pkg/tsconfig.test.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['test/**/*.ts'],
      }),
      'tsconfig.json': json({
        files: [],
        references: [
          {
            path: './packages/pkg/tsconfig.json',
          },
        ],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: ['tsconfig.json'],
            },
          },
        },
      });

      expect(result.manifest.checkers.tsc?.roots).toEqual([
        'packages/pkg/tsconfig.lib.json',
        'packages/pkg/tsconfig.test.json',
      ]);

      const buildConfig = JSON.parse(
        await readFile(
          path.join(
            fixture.rootDir,
            '.limina/tsconfig/checkers/tsc/tsconfig.build.json',
          ),
          'utf8',
        ),
      ) as {
        references: { path: string }[];
      };

      expect(buildConfig.references).toEqual([
        {
          path: './projects/packages/pkg/tsconfig.lib.dts.json',
        },
        {
          path: './projects/packages/pkg/tsconfig.test.dts.json',
        },
      ]);

      const rootSolutionConfig = JSON.parse(
        await readFile(
          path.join(
            fixture.rootDir,
            '.limina/tsconfig/checkers/tsc/solutions/tsconfig.build.json',
          ),
          'utf8',
        ),
      ) as {
        references: { path: string }[];
      };

      expect(rootSolutionConfig.references).toEqual([
        {
          path: '../projects/packages/pkg/tsconfig.lib.dts.json',
        },
        {
          path: '../projects/packages/pkg/tsconfig.test.dts.json',
        },
      ]);

      const packageSolutionConfig = JSON.parse(
        await readFile(
          path.join(
            fixture.rootDir,
            '.limina/tsconfig/checkers/tsc/solutions/packages/pkg/tsconfig.build.json',
          ),
          'utf8',
        ),
      ) as {
        references: { path: string }[];
      };

      expect(packageSolutionConfig.references).toEqual([
        {
          path: '../../../projects/packages/pkg/tsconfig.lib.dts.json',
        },
        {
          path: '../../../projects/packages/pkg/tsconfig.test.dts.json',
        },
      ]);
      expect(result.manifest.checkers.tsc?.sourceToDts).toMatchObject({
        'packages/pkg/tsconfig.lib.json':
          '.limina/tsconfig/checkers/tsc/projects/packages/pkg/tsconfig.lib.dts.json',
        'packages/pkg/tsconfig.test.json':
          '.limina/tsconfig/checkers/tsc/projects/packages/pkg/tsconfig.test.dts.json',
      });
      expect(result.manifest.checkers.tsc?.sourceToBuild).toMatchObject({
        'tsconfig.json': {
          kind: 'solution',
          path: '.limina/tsconfig/checkers/tsc/solutions/tsconfig.build.json',
        },
        'packages/pkg/tsconfig.json': {
          kind: 'solution',
          path: '.limina/tsconfig/checkers/tsc/solutions/packages/pkg/tsconfig.build.json',
        },
        'packages/pkg/tsconfig.lib.json': {
          kind: 'project',
          path: '.limina/tsconfig/checkers/tsc/projects/packages/pkg/tsconfig.lib.dts.json',
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not apply checker entry exclude to solution references', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/vue/index.ts': 'export const vueValue = 1;\n',
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
          {
            path: './vue/tsconfig.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/pkg/vue/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: ['packages/pkg/tsconfig.json'],
              exclude: ['packages/pkg/vue/tsconfig.json'],
            },
          },
        },
      });

      expect(result.manifest.checkers.tsc?.roots).toEqual([
        'packages/pkg/tsconfig.lib.json',
        'packages/pkg/vue/tsconfig.json',
      ]);
      expect(result.manifest.checkers.tsc?.sourceToDts).toEqual({
        'packages/pkg/tsconfig.lib.json':
          '.limina/tsconfig/checkers/tsc/projects/packages/pkg/tsconfig.lib.dts.json',
        'packages/pkg/vue/tsconfig.json':
          '.limina/tsconfig/checkers/tsc/projects/packages/pkg/vue/tsconfig.dts.json',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects source tsconfig.json entries that still declare project references', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: ['packages/pkg/tsconfig.json'],
              },
            },
          },
        }),
      ).rejects.toThrow('Source typecheck config declares project references');
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses Vue checker files when deciding whether a default config is a solution', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/App.vue':
        '<script setup lang="ts">const value = 1;</script>\n',
      'packages/pkg/tsconfig.json': json({
        include: ['src/**/*'],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.vue'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              'vue-tsc': {
                include: ['packages/pkg/tsconfig.json'],
              },
            },
          },
        }),
      ).rejects.toThrow('Source typecheck config declares project references');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects overlapping checker entry configs', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: ['packages/pkg/tsconfig.json'],
              },
              tsgo: {
                include: ['packages/pkg/tsconfig.json'],
              },
            },
          },
        }),
      ).rejects.toThrow('Checker ownership conflict');
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves overlapping explicit sources and rejects different native checker engines', async () => {
    const fixture = await createFixture({
      'packages/one/tsconfig.json': json({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/two/tsconfig.json': json({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/shared/src/index.ts': 'export const value = 1;\n',
      'packages/shared/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const shared = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: [
                'packages/one/tsconfig.json',
                'packages/two/tsconfig.json',
              ],
            },
          },
        },
      });
      const source = fixture.path('packages/shared/tsconfig.lib.json');
      expect(shared.governedSources.get('tsc')?.size).toBe(1);
      expect(
        shared.ownershipPlan.typeConfigs
          .get(source)
          ?.evidence.filter((entry) => entry.source === 'explicit')
          .map((entry) => entry.configPath)
          .sort((left, right) => left.localeCompare(right)),
      ).toEqual([
        fixture.path('packages/one/tsconfig.json'),
        fixture.path('packages/two/tsconfig.json'),
      ]);
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: ['packages/one/tsconfig.json'],
              },
              tsgo: {
                include: ['packages/two/tsconfig.json'],
              },
            },
          },
        }),
      ).rejects.toThrow('packages/shared/tsconfig.lib.json');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects different-preset primary owners that share a solution-expanded leaf', async () => {
    const fixture = await createFixture({
      'packages/one/tsconfig.json': json({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/two/tsconfig.json': json({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/shared/src/index.ts': 'export const value = 1;\n',
      'packages/shared/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: ['packages/two/tsconfig.json'],
              },
              tsgo: {
                include: ['packages/one/tsconfig.json'],
              },
            },
          },
        }),
      ).rejects.toThrow('Checker ownership conflict');
    } finally {
      await fixture.cleanup();
    }
  });

  it('lets auto ownership select the checker that observes the source files', async () => {
    const fixture = await createFixture({
      'packages/app/src/App.vue': '<template><div /></template>\n',
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: { auto: {} },
        },
      });
      expect(result.manifest.ownership.configs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            config: 'packages/app/tsconfig.json',
            owner: 'vue-tsc',
          }),
        ]),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects cross-preset capability overlap on one source config', async () => {
    const fixture = await createFixture({
      'packages/ts/tsconfig.json': json({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/vue/tsconfig.json': json({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/shared/src/App.vue': '<template><div /></template>\n',
      'packages/shared/src/index.ts': 'export const value = 1;\n',
      'packages/shared/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: ['packages/ts/tsconfig.json'],
              },
              'vue-tsc': {
                include: ['packages/vue/tsconfig.json'],
              },
            },
          },
        }),
      ).rejects.toThrow('Checker ownership conflict');
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores VitePress fenced imports while retaining real generated references', async () => {
    const fixture = await createFixture({
      'packages/app/package.json': json({
        name: '@fixture/app',
        private: true,
      }),
      'packages/app/src/Page.md': [
        '# Page',
        '',
        '```vue',
        "<script setup>import '../../missing/src/value';</script>",
        '```',
        '',
        '<script setup lang="ts">',
        "import { value } from '../../shared/src/value';",
        'void value;',
        '</script>',
        '',
      ].join('\n'),
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
        vueCompilerOptions: { vitePressExtensions: ['.md'] },
      }),
      'packages/shared/package.json': json({
        name: '@fixture/shared',
        private: true,
      }),
      'packages/shared/src/value.ts': 'export const value = true;\n',
      'packages/shared/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            'vue-tsc': { include: ['packages/app/tsconfig.json'] },
          },
        },
      });

      expect(
        result.manifest.dependencyEdges.map((edge) => ({
          fromChecker: edge.fromChecker,
          importedSpecifier: edge.importedSpecifier,
          toChecker: edge.toChecker,
        })),
      ).toEqual([
        {
          fromChecker: 'vue-tsc',
          importedSpecifier: '../../shared/src/value',
          toChecker: 'vue-tsc',
        },
      ]);
      expect(
        await readGeneratedReferences({
          checkerName: 'vue-tsc',
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).toEqual([
        {
          path: '../shared/tsconfig.dts.json',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('retains denied Native relations between incompatible checker components', async () => {
    const projectConfig = (labels: string[]) =>
      json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          types: [],
        },
        include: ['src/**/*.ts'],
        liminaOptions: { graphRules: labels },
      });
    const imports = Array.from(
      { length: 8 },
      (_, index) =>
        `import type { Value as V${index} } from '../../theme/src/index';\nexport type T${index} = V${index};`,
    ).join('\n');
    const fixture = await createFixture({
      'packages/app/src/index.ts': imports,
      'packages/app/tsconfig.json': projectConfig([]),
      'packages/other/src/index.ts': imports,
      'packages/other/tsconfig.json': projectConfig([]),
      'packages/theme/src/index.ts': 'export interface Value { x: string }',
      'packages/theme/tsconfig.json': projectConfig([]),
    });
    const selectedConfig: ResolvedLiminaConfig = {
      ...fixture.config,
      scope: {
        regions: fixture.config.scope?.regions,
        checkers: {
          tsc: { include: ['packages/app/tsconfig.json'] },
          tsgo: {
            include: [
              'packages/other/tsconfig.json',
              'packages/theme/tsconfig.json',
            ],
          },
        },
      },
      graph: {
        rules: {
          separate: {
            deny: {
              refs: [
                {
                  path: 'packages/theme/tsconfig.json',
                  reason: 'separate component',
                },
              ],
            },
          },
        },
      },
    };
    try {
      await expect(
        resolveGeneratedGraphCheckers(selectedConfig),
      ).rejects.toThrow('Build checker ownership conflict');

      await writeText(
        fixture.path('packages/app/tsconfig.json'),
        projectConfig([' separate ', 'separate']),
      );
      await expect(
        resolveGeneratedGraphCheckers(selectedConfig),
      ).rejects.toThrow('Build checker ownership conflict');

      await writeText(
        fixture.path('packages/app/tsconfig.json'),
        projectConfig([]),
      );
      await expect(
        resolveGeneratedGraphCheckers(selectedConfig),
      ).rejects.toThrow('Build checker ownership conflict');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects different build checker identities in one import component', async () => {
    const fixture = await createFixture({
      'packages/app-entry/tsconfig.json': json({
        include: [],
        references: [{ path: '../app' }],
      }),
      'packages/theme-entry/tsconfig.json': json({
        include: [],
        references: [{ path: '../theme' }],
      }),
      'packages/app/src/index.ts':
        "import { themeValue } from '../../theme/src/theme';\nexport const value = themeValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme/src/theme.ts': 'export const themeValue = 1;\n',
      'packages/theme/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const preparation = prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: ['packages/app-entry/tsconfig.json'],
            },
            tsgo: {
              include: ['packages/theme-entry/tsconfig.json'],
            },
          },
        },
      });
      await expect(preparation).rejects.toThrow(
        'Build checker ownership conflict',
      );
      await expect(preparation).rejects.toThrow(
        'origin: explicit at packages/app-entry/tsconfig.json',
      );
      await expect(preparation).rejects.toThrow(
        'origin: explicit at packages/theme-entry/tsconfig.json',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects duplicate primary providers before provider selection', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { themeValue } from '../../theme/src/theme';\nexport const value = themeValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme-ts/tsconfig.json': json({
        files: [],
        references: [
          {
            path: '../theme/tsconfig.lib.json',
          },
        ],
      }),
      'packages/theme-vue/tsconfig.json': json({
        files: [],
        references: [
          {
            path: '../theme/tsconfig.lib.json',
          },
        ],
      }),
      'packages/theme/src/theme.ts': 'export const themeValue = 1;\n',
      'packages/theme/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: ['packages/app/tsconfig.json'],
              },
              tsgo: {
                include: ['packages/theme-ts/tsconfig.json'],
              },
              'vue-tsc': {
                include: ['packages/theme-vue/tsconfig.json'],
              },
            },
          },
        }),
      ).rejects.toThrow('Checker ownership conflict');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects an explicitly tsc-owned consumer of an untyped vue-tsc source', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { themeValue } from '../../theme/src/theme';\nexport const value = themeValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme/src/theme.ts': 'export const themeValue = 1;\n',
      'packages/theme/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: ['packages/app/tsconfig.json'],
              },
              'vue-tsc': {
                include: ['packages/theme/tsconfig.json'],
              },
            },
          },
        }),
      ).rejects.toThrow('Build checker ownership conflict');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a provider reached through conflicting inherited checker paths', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { themeValue } from '../../theme/src/theme';\nexport const value = themeValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme-one/tsconfig.json': json({
        files: [],
        references: [
          {
            path: '../theme/tsconfig.lib.json',
          },
        ],
      }),
      'packages/theme-two/tsconfig.json': json({
        files: [],
        references: [
          {
            path: '../theme/tsconfig.lib.json',
          },
        ],
      }),
      'packages/theme/src/theme.ts': 'export const themeValue = 1;\n',
      'packages/theme/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      let thrown: unknown;

      try {
        await prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: ['packages/app/tsconfig.json'],
              },
              tsgo: {
                include: ['packages/theme-one/tsconfig.json'],
              },
              'vue-tsc': {
                include: ['packages/theme-two/tsconfig.json'],
              },
            },
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(String(thrown)).toContain('Checker ownership conflict');
      expect(String(thrown)).toContain('tsgo');
      expect(String(thrown)).toContain('vue-tsc');
      expect(thrown).toBeInstanceOf(LiminaStructuredError);

      const issue = (thrown as LiminaStructuredError).issues.find(
        (item) => item.title === 'Checker ownership conflict',
      );

      expect(issue).toMatchObject({
        title: 'Checker ownership conflict',
      });
      expect(
        existsSync(
          path.join(
            fixture.rootDir,
            '.limina/tsconfig/checkers/app/projects/packages/app/tsconfig.dts.json',
          ),
        ),
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not infer declaration references or provider edges from require.resolve imports', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "export const themePath = require.resolve('../../theme/src/theme');\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme/src/theme.ts': 'export const themeValue = 1;\n',
      'packages/theme/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: ['packages/app/tsconfig.json'],
            },
            'vue-tsc': {
              include: ['packages/theme/tsconfig.json'],
            },
          },
        },
      });

      expect(result.manifest.dependencyEdges).toEqual([]);
      expect(result.dependencyEdges).toEqual([]);
      await expect(
        readGeneratedReferences({
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).resolves.toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['ts', 'tsx'] as const)(
    'writes same-checker declaration references for static %s imports',
    async (extension) => {
      const fixture = await createFixture({
        [`packages/app/src/index.${extension}`]:
          "import { themeValue } from '../../theme/src/theme';\nexport const value = themeValue;\n",
        'packages/app/tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: [`src/**/*.${extension}`],
        }),
        'packages/theme/src/theme.ts': 'export const themeValue = 1;\n',
        'packages/theme/tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      });

      try {
        await prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: [
                  'packages/app/tsconfig.json',
                  'packages/theme/tsconfig.json',
                ],
              },
            },
          },
        });

        const generatedConfig = JSON.parse(
          await readFile(
            path.join(
              fixture.rootDir,
              '.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.dts.json',
            ),
            'utf8',
          ),
        ) as {
          references: { path: string }[];
        };

        expect(generatedConfig.references).toEqual([
          {
            path: '../theme/tsconfig.dts.json',
          },
        ]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('writes a policy reference for a uniquely covered TypeScript declaration', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { themeValue } from '../../theme/src/index';\nexport const value = themeValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme/src/index.d.ts':
        'export declare const themeValue: number;\n',
      'packages/theme/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.d.ts'],
      }),
    });

    try {
      await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: [
                'packages/app/tsconfig.json',
                'packages/theme/tsconfig.json',
              ],
            },
          },
        },
      });

      const generatedConfig = JSON.parse(
        await readFile(
          path.join(
            fixture.rootDir,
            '.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.dts.json',
          ),
          'utf8',
        ),
      ) as {
        references: { path: string }[];
      };

      expect(generatedConfig.references).toEqual([
        { path: '../theme/tsconfig.dts.json' },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([false, true])(
    'does not admit governed workspace source through node_modules with preserveSymlinks=%s',
    async (preserveSymlinks) => {
      const fixture = await createFixture({
        'packages/app/package.json': json({
          name: '@example/app',
          private: true,
          type: 'module',
        }),
        'packages/app/src/index.ts': [
          "import { providerValue } from '@example/provider';",
          "import virtualValue from 'virtual-foreign';",
          'void providerValue;',
          'void virtualValue;',
          '',
        ].join('\n'),
        'packages/app/tsconfig.json': json({
          compilerOptions: {
            ...managedOutputCompilerOptions(),
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            preserveSymlinks,
          },
          include: ['src/**/*.ts'],
        }),
        'packages/provider/package.json': json({
          exports: { '.': './src/index.ts' },
          name: '@example/provider',
          type: 'module',
        }),
        'packages/provider/src/env.d.ts': [
          "declare module 'virtual-foreign' {",
          '  const value: true;',
          '  export default value;',
          '}',
          '',
        ].join('\n'),
        'packages/provider/src/index.ts': [
          '/// <reference path="./env.d.ts" />',
          'export const providerValue = 1;',
          '',
        ].join('\n'),
        'packages/provider/tsconfig.json': json({
          compilerOptions: {
            ...managedOutputCompilerOptions(),
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
          },
          include: ['src/**/*.ts'],
        }),
      });

      try {
        await linkWorkspacePackage(
          fixture.rootDir,
          'packages/app',
          'packages/provider',
          '@example/provider',
        );
        const result = await prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: [
                  'packages/app/tsconfig.json',
                  'packages/provider/tsconfig.json',
                ],
              },
            },
          },
        });
        const appConfigPath = normalizeAbsolutePath(
          path.join(fixture.rootDir, 'packages/app/tsconfig.json'),
        );
        const facts = result.ownershipPlan.dependencyFacts.filter(
          (fact) => fact.consumerConfigPath === appConfigPath,
        );

        expect(
          facts.find(
            (fact) => fact.importRecord.specifier === '@example/provider',
          ),
        ).toMatchObject({
          physicalTargetProvenance: null,
          typeEvidenceKind: 'unobserved',
          referenceRequirement: null,
          nativeEvidence: { obligation: { existence: { state: 'absent' } } },
        });
        expect(result.dependencyEdges).toEqual([]);
        expect(
          facts.filter(
            (fact) => fact.importRecord.specifier === 'virtual-foreign',
          ),
        ).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('keeps same-checker managed output declarations as artifact boundaries', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { providerValue } from '@example/provider';\nexport const value = providerValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
      'packages/provider/dist/index.d.ts':
        'export declare const providerValue: number;\n',
      'packages/provider/dist/index.js': 'export const providerValue = 1;\n',
      'packages/provider/package.json': json({
        exports: {
          '.': {
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
        },
        name: '@example/provider',
        type: 'module',
      }),
      'packages/provider/src/index.ts': 'export const providerValue = 1;\n',
      'packages/provider/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
        liminaOptions: {
          outputs: {
            rootDir: 'src',
            outDir: 'dist',
          },
        },
      }),
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/provider',
        '@example/provider',
      );

      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: [
                'packages/app/tsconfig.json',
                'packages/provider/tsconfig.json',
              ],
            },
          },
        },
      });

      expect(result.manifest.dependencyEdges).toEqual([]);
      await expect(
        readGeneratedReferences({
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).resolves.toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps Vue managed output declarations as artifact boundaries', async () => {
    const fixture = await createFixture({
      'packages/app/src/App.vue':
        '<script setup lang="ts">\nimport Button from \'@example/theme\';\nvoid Button;\n</script>\n',
      'packages/app/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.vue'],
      }),
      'packages/theme/dist/Button.js': `export default {};
`,
      'packages/theme/dist/Button.vue.d.ts': `declare const Button: unknown;
export default Button;
`,
      'packages/theme/package.json': json({
        exports: {
          '.': {
            default: './dist/Button.js',
            types: './dist/Button.vue.d.ts',
          },
        },
        name: '@example/theme',
        type: 'module',
      }),
      'packages/theme/src/Button.vue':
        '<script setup lang="ts">const label = "Button";</script>\n',
      'packages/theme/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.vue'],
        liminaOptions: {
          outputs: {
            outDir: 'dist',
            rootDir: 'src',
          },
        },
      }),
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/theme',
        '@example/theme',
      );

      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            'vue-tsc': {
              include: [
                'packages/app/tsconfig.json',
                'packages/theme/tsconfig.json',
              ],
            },
          },
        },
      });

      expect(result.manifest.dependencyEdges).toEqual([]);
      await expect(
        readGeneratedReferences({
          checkerName: 'vue-tsc',
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).resolves.toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not schedule output builds for existing managed declarations', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { providerValue } from '@example/provider';\nexport const value = providerValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
        liminaOptions: {
          outputs: {
            rootDir: 'src',
            outDir: 'dist',
          },
        },
      }),
      'packages/provider/dist/index.d.ts':
        'export declare const providerValue: number;\n',
      'packages/provider/dist/index.js': 'export const providerValue = 1;\n',
      'packages/provider/package.json': json({
        exports: {
          '.': {
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
        },
        name: '@example/provider',
        type: 'module',
      }),
      'packages/provider/src/index.ts': 'export const providerValue = 1;\n',
      'packages/provider/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
        liminaOptions: {
          outputs: {
            rootDir: 'src',
            outDir: 'dist',
          },
        },
      }),
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/provider',
        '@example/provider',
      );

      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: [
                'packages/app/tsconfig.json',
                'packages/provider/tsconfig.json',
              ],
            },
          },
        },
      });

      const outputConfig = JSON.parse(
        await readFile(
          path.join(
            fixture.rootDir,
            '.limina/tsconfig/checkers/tsc/outputs/projects/packages/app/tsconfig.output.json',
          ),
          'utf8',
        ),
      ) as {
        references: { path: string }[];
      };

      expect(result.manifest.dependencyEdges).toEqual([]);
      expect(outputConfig.references).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps unowned declarations under outDir as declaration boundaries', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { providerValue } from '@example/provider';\nexport const value = providerValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
      'packages/provider/dist/index.d.ts':
        'export declare const providerValue: number;\n',
      'packages/provider/dist/index.js': 'export const providerValue = 1;\n',
      'packages/provider/package.json': json({
        exports: {
          '.': {
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
        },
        name: '@example/provider',
        type: 'module',
      }),
      'packages/provider/src/other.ts': 'export const otherValue = 1;\n',
      'packages/provider/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
        liminaOptions: {
          outputs: {
            rootDir: 'src',
            outDir: 'dist',
          },
        },
      }),
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/provider',
        '@example/provider',
      );

      await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: [
                'packages/app/tsconfig.json',
                'packages/provider/tsconfig.json',
              ],
            },
          },
        },
      });

      await expect(
        readGeneratedReferences({
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).resolves.toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('references source-owned package declarations without requiring output emission', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { providerValue } from '@example/provider';\nexport const value = providerValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
      'packages/provider/package.json': json({
        exports: {
          '.': {
            types: './src/index.d.ts',
          },
        },
        name: '@example/provider',
        type: 'module',
      }),
      'packages/provider/src/index.d.ts':
        'export declare const providerValue: number;\n',
      'packages/provider/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.d.ts'],
      }),
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/provider',
        '@example/provider',
      );

      await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: [
                'packages/app/tsconfig.json',
                'packages/provider/tsconfig.json',
              ],
            },
          },
        },
      });

      await expect(
        readGeneratedReferences({
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).resolves.toEqual([{ path: '../provider/tsconfig.dts.json' }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps ambiguous managed output declarations as declaration boundaries', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { providerValue } from '@example/provider';\nexport const value = providerValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
      'packages/provider/dist/index.d.ts':
        'export declare const providerValue: number;\n',
      'packages/provider/dist/index.js': 'export const providerValue = 1;\n',
      'packages/provider/package.json': json({
        exports: {
          '.': {
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
        },
        name: '@example/provider',
        type: 'module',
      }),
      'packages/provider/src-a/index.ts': 'export const providerValue = 1;\n',
      'packages/provider/src-b/index.ts': 'export const providerValue = 1;\n',
      'packages/provider/tsconfig.a.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src-a/**/*.ts'],
        liminaOptions: {
          outputs: {
            rootDir: 'src-a',
            outDir: 'dist',
          },
        },
      }),
      'packages/provider/tsconfig.b.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src-b/**/*.ts'],
        liminaOptions: {
          outputs: {
            rootDir: 'src-b',
            outDir: 'dist',
          },
        },
      }),
      'packages/provider/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.a.json',
          },
          {
            path: './tsconfig.b.json',
          },
        ],
      }),
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/provider',
        '@example/provider',
      );

      await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: [
                'packages/app/tsconfig.json',
                'packages/provider/tsconfig.json',
              ],
            },
          },
        },
      });

      await expect(
        readGeneratedReferences({
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).resolves.toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps denied managed output declarations as artifact boundaries', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { providerValue } from '@example/provider';\nexport const value = providerValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
        liminaOptions: {
          graphRules: ['app'],
        },
      }),
      'packages/provider/dist/index.d.ts':
        'export declare const providerValue: number;\n',
      'packages/provider/dist/index.js': 'export const providerValue = 1;\n',
      'packages/provider/package.json': json({
        exports: {
          '.': {
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
        },
        name: '@example/provider',
        type: 'module',
      }),
      'packages/provider/src/index.ts': 'export const providerValue = 1;\n',
      'packages/provider/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
        liminaOptions: {
          outputs: {
            rootDir: 'src',
            outDir: 'dist',
          },
        },
      }),
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/provider',
        '@example/provider',
      );

      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: [
                'packages/app/tsconfig.json',
                'packages/provider/tsconfig.json',
              ],
            },
          },
        },
        graph: {
          rules: {
            app: {
              deny: {
                refs: [
                  {
                    path: 'packages/provider/tsconfig.json',
                    reason: 'blocked',
                  },
                ],
              },
            },
          },
        },
      });

      expect(result.manifest.dependencyEdges).toEqual([]);
      await expect(
        readGeneratedReferences({
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).resolves.toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows cross-checker consumption of an existing managed declaration', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { providerValue } from '@example/provider';\nexport const value = providerValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
      'packages/provider/dist/index.d.ts':
        'export declare const providerValue: number;\n',
      'packages/provider/dist/index.js': 'export const providerValue = 1;\n',
      'packages/provider/package.json': json({
        exports: {
          '.': {
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
        },
        name: '@example/provider',
        type: 'module',
      }),
      'packages/provider/src/index.ts': 'export const providerValue = 1;\n',
      'packages/provider/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
        liminaOptions: {
          outputs: {
            rootDir: 'src',
            outDir: 'dist',
          },
        },
      }),
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/provider',
        '@example/provider',
      );

      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            tsc: {
              include: ['packages/app/tsconfig.json'],
            },
            tsgo: {
              include: ['packages/provider/tsconfig.json'],
            },
          },
        },
      });

      expect(result.manifest.ownership.configs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            config: 'packages/app/tsconfig.json',
            owner: 'tsc',
          }),
          expect.objectContaining({
            config: 'packages/provider/tsconfig.json',
            owner: 'tsgo',
          }),
        ]),
      );
      expect(result.manifest.dependencyEdges).toEqual([]);
      await expect(
        readGeneratedReferences({
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).resolves.toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a solution constraint that conflicts with an explicitly owned output leaf', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { providerValue } from '@example/provider';\nexport const value = providerValue;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
      }),
      'packages/provider/dist/index.d.ts':
        'export declare const providerValue: number;\n',
      'packages/provider/dist/index.js': 'export const providerValue = 1;\n',
      'packages/provider/package.json': json({
        exports: {
          '.': {
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
        },
        name: '@example/provider',
        type: 'module',
      }),
      'packages/provider/src/index.ts': 'export const providerValue = 1;\n',
      'packages/provider/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src/**/*.ts'],
        liminaOptions: {
          outputs: {
            rootDir: 'src',
            outDir: 'dist',
          },
        },
      }),
      'tsconfig.json': json({
        files: [],
        references: [
          {
            path: './packages/provider/tsconfig.json',
          },
        ],
      }),
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/provider',
        '@example/provider',
      );

      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          scope: {
            regions: fixture.config.scope?.regions,
            checkers: {
              tsc: {
                include: [
                  'packages/app/tsconfig.json',
                  'packages/provider/tsconfig.json',
                ],
              },
              'vue-tsc': {
                include: ['tsconfig.json'],
              },
            },
          },
        }),
      ).rejects.toThrow('Checker ownership conflict');
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes references for Vue source providers governed by vue-tsc', async () => {
    const fixture = await createFixture({
      'packages/app/src/App.vue':
        '<script setup lang="ts">\nimport Theme from \'../../theme/src/Theme.vue\';\nvoid Theme;\n</script>\n',
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.vue'],
      }),
      'packages/theme/src/Theme.vue':
        '<script setup lang="ts">const value = 1;</script>\n',
      'packages/theme/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.vue'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            'vue-tsc': {
              include: [
                'packages/app/tsconfig.json',
                'packages/theme/tsconfig.json',
              ],
            },
          },
        },
      });

      expect(result.manifest.dependencyEdges).toMatchObject([
        {
          cacheReuse: 'reusable',
          fromChecker: 'vue-tsc',
          kind: 'declaration-provider',
          toChecker: 'vue-tsc',
        },
      ]);

      const generatedConfig = JSON.parse(
        await readFile(
          path.join(
            fixture.rootDir,
            '.limina/tsconfig/checkers/vue-tsc/projects/packages/app/tsconfig.dts.json',
          ),
          'utf8',
        ),
      ) as {
        references: { path: string }[];
      };

      expect(generatedConfig.references).toEqual([
        {
          path: '../theme/tsconfig.dts.json',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps physical and missing resource modules out of the Vue provider graph', async () => {
    const fixture = await createFixture({
      'packages/app/src/App.vue': [
        '<script setup lang="ts">',
        "import Theme from '../../theme/src/Theme.vue';",
        "import './style.css';",
        "import './icon.svg';",
        "import './data.yaml';",
        "import './readme.txt';",
        "import './missing.css';",
        'void Theme;',
        '</script>',
        '',
      ].join('\n'),
      'packages/app/src/data.yaml': 'value: true\n',
      'packages/app/src/icon.svg': '<svg />\n',
      'packages/app/src/readme.txt': 'resource\n',
      'packages/app/src/style.css': '.root {}\n',
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.vue'],
      }),
      'packages/theme/src/Theme.vue':
        '<script setup lang="ts">const value = 1;</script>\n',
      'packages/theme/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.vue'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        scope: {
          regions: fixture.config.scope?.regions,
          checkers: {
            'vue-tsc': {
              include: [
                'packages/app/tsconfig.json',
                'packages/theme/tsconfig.json',
              ],
            },
          },
        },
      });

      expect(result.manifest.dependencyEdges).toMatchObject([
        {
          cacheReuse: 'reusable',
          fromChecker: 'vue-tsc',
          kind: 'declaration-provider',
          toChecker: 'vue-tsc',
        },
      ]);
      expect(
        await readGeneratedReferences({
          checkerName: 'vue-tsc',
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).toEqual([
        {
          path: '../theme/tsconfig.dts.json',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('references the context of a cross-project hand-written arbitrary-extension declaration', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import className from '../../theme/src/button.css';\nexport const value = className;\n",
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          allowArbitraryExtensions: true,
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme/src/button.css': '.button {}\n',
      'packages/theme/src/button.d.css.ts': `declare const className: string;
export default className;
`,
      'packages/theme/tsconfig.json': json({
        compilerOptions: {
          allowArbitraryExtensions: true,
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);

      expect(result.manifest.dependencyEdges).toMatchObject([
        {
          kind: 'declaration-provider',
          toConfig: 'packages/theme/tsconfig.json',
        },
      ]);
      expect(
        await readGeneratedReferences({
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).toEqual([{ path: '../theme/tsconfig.dts.json' }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['tsc', 'tsgo'] as const)(
    'keeps an explicit %s semantic miss final without calling Oxc',
    async (checkerName) => {
      const fixture = await createFixture({
        'packages/app/src/index.ts':
          "import Theme from '../../theme/src/Theme.vue';\nexport const value = Theme;\n",
        'packages/app/tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
        'packages/theme/src/Theme.vue':
          '<script setup lang="ts">const value = 1;</script>\n',
        'packages/theme/tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.vue'],
        }),
      });
      const importAnalysis = createImportAnalysisContext();
      const resolveOxcImport = vi.fn(importAnalysis.resolveOxcImport);

      try {
        const result = await prepareGeneratedTsconfigGraph(
          {
            ...fixture.config,
            scope: {
              regions: fixture.config.scope?.regions,
              checkers: {
                [checkerName]: {
                  include: ['packages/app/tsconfig.json'],
                },
              },
            },
          },
          {
            importAnalysisContext: {
              ...importAnalysis,
              resolveOxcImport,
            },
          },
        );
        expect(resolveOxcImport).not.toHaveBeenCalled();
        expect(result.manifest.dependencyEdges).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([1, 2, 3, 4])(
    'uses manifest v%s as an ownership ledger while removing stale generated files',
    async (manifestVersion) => {
      const fixture = await createFixture({
        '.limina/manifest.json': json({
          generatedBy: 'limina',
          ownedArtifacts: [
            'tsconfig/checkers/tsc/projects/stale/tsconfig.dts.json',
            'manifest.json',
          ],
          version: manifestVersion,
        }),
        '.limina/tsconfig/checkers/tsc/projects/stale/tsconfig.dts.json':
          '{}\n',
        'packages/pkg/src/index.ts': 'export const value = 1;\n',
        'packages/pkg/tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      });

      try {
        await prepareGeneratedTsconfigGraph(fixture.config);

        expect(
          existsSync(
            path.join(
              fixture.rootDir,
              '.limina/tsconfig/checkers/tsc/projects/stale/tsconfig.dts.json',
            ),
          ),
        ).toBe(false);
        const manifest = JSON.parse(
          await readFile(
            path.join(fixture.rootDir, '.limina/manifest.json'),
            'utf8',
          ),
        ) as { version: number };
        expect(manifest.version).toBe(6);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([
    {
      manifest: '{',
      name: 'malformed JSON',
    },
    {
      manifest: json({
        generatedBy: 'limina',
        ownedArtifacts: ['manifest.json'],
        version: 7,
      }),
      name: 'a future version',
    },
  ])('rejects an existing manifest with $name', async ({ manifest }) => {
    const fixture = await createFixture({
      '.limina/manifest.json': manifest,
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes implicit references as generated declaration references', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/app/tsconfig.lib.json': json({
        liminaOptions: {
          implicitRefs: [
            {
              path: '../core/tsconfig.lib.json',
              reason: 'Loaded by a generated route manifest.',
            },
            {
              path: '../core/tsconfig.lib.json',
              reason: 'Duplicate dynamic source edge.',
            },
          ],
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/core/src/index.ts': 'export const coreValue = 1;\n',
      'packages/core/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/core/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await prepareGeneratedTsconfigGraph(fixture.config);

      const generatedConfig = JSON.parse(
        await readFile(
          path.join(
            fixture.rootDir,
            '.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.lib.dts.json',
          ),
          'utf8',
        ),
      ) as {
        references: { path: string }[];
      };

      expect(generatedConfig.references).toEqual([
        {
          path: '../core/tsconfig.lib.dts.json',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('deduplicates implicit references that static imports also prove', async () => {
    const fixture = await createFixture({
      'packages/pkg/node.ts': 'export const nodeValue = 1;\n',
      'packages/pkg/runtime.ts':
        "import { nodeValue } from './node';\nexport const runtimeValue = nodeValue;\n",
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.node.json',
          },
          {
            path: './tsconfig.runtime.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.node.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['node.ts'],
      }),
      'packages/pkg/tsconfig.runtime.json': json({
        liminaOptions: {
          implicitRefs: [
            {
              path: './tsconfig.node.json',
              reason: 'Also loaded dynamically by the runtime manifest.',
            },
          ],
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['runtime.ts'],
      }),
    });

    try {
      await prepareGeneratedTsconfigGraph(fixture.config);

      const generatedConfig = JSON.parse(
        await readFile(
          path.join(
            fixture.rootDir,
            '.limina/tsconfig/checkers/tsc/projects/packages/pkg/tsconfig.runtime.dts.json',
          ),
          'utf8',
        ),
      ) as {
        references: { path: string }[];
      };

      expect(generatedConfig.references).toEqual([
        {
          path: './tsconfig.node.dts.json',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  const invalidImplicitReferenceCases: {
    expected: string;
    files: Record<string, string>;
    name: string;
  }[] = [
    {
      expected: 'implicitRefs must be an array',
      files: {
        'packages/app/tsconfig.json': json({
          liminaOptions: {
            implicitRefs: true,
          },
          include: ['src/**/*.ts'],
        }),
      },
      name: 'non-array implicitRefs',
    },
    {
      expected: 'implicitRefs reason is required',
      files: {
        'packages/app/tsconfig.json': json({
          liminaOptions: {
            implicitRefs: [
              {
                path: '../core/tsconfig.json',
                reason: '',
              },
            ],
          },
          include: ['src/**/*.ts'],
        }),
        'packages/core/tsconfig.json': json({
          include: ['src/**/*.ts'],
        }),
      },
      name: 'empty reason',
    },
    {
      expected:
        'implicitRefs path must point to an existing ordinary source tsconfig',
      files: {
        'packages/app/tsconfig.json': json({
          liminaOptions: {
            implicitRefs: [
              {
                path: '../missing/tsconfig.json',
                reason: 'Loaded dynamically.',
              },
            ],
          },
          include: ['src/**/*.ts'],
        }),
      },
      name: 'missing target',
    },
    {
      expected: 'implicitRefs must not reference the declaring tsconfig',
      files: {
        'packages/app/tsconfig.json': json({
          liminaOptions: {
            implicitRefs: [
              {
                path: './tsconfig.json',
                reason: 'Self references are not valid.',
              },
            ],
          },
          include: ['src/**/*.ts'],
        }),
      },
      name: 'self reference',
    },
    {
      expected:
        'implicitRefs path must point to an ordinary source tsconfig*.json file',
      files: {
        'packages/app/tsconfig.json': json({
          liminaOptions: {
            implicitRefs: [
              {
                path: '../core/tsconfig.lib.dts.json',
                reason: 'Loaded dynamically.',
              },
            ],
          },
          include: ['src/**/*.ts'],
        }),
        'packages/core/tsconfig.lib.dts.json': json({
          files: [],
        }),
      },
      name: 'reserved target',
    },
    {
      expected:
        'implicitRefs must point to an ordinary source tsconfig selected by the same checker.include set',
      files: {
        'external/src/index.ts': 'export const value = 1;\n',
        'external/tsconfig.json': json({
          include: ['src/**/*.ts'],
        }),
        'packages/app/tsconfig.json': json({
          liminaOptions: {
            implicitRefs: [
              {
                path: '../../external/tsconfig.json',
                reason: 'Loaded dynamically.',
              },
            ],
          },
          include: ['src/**/*.ts'],
        }),
      },
      name: 'unselected target',
    },
  ];

  it.each(invalidImplicitReferenceCases)(
    'rejects invalid implicit references: $name',
    async (caseValue) => {
      const fixture = await createFixture({
        'packages/app/src/index.ts': 'export const value = 1;\n',
        'packages/core/src/index.ts': 'export const coreValue = 1;\n',
        ...caseValue.files,
      });

      try {
        const config =
          caseValue.name === 'unselected target'
            ? {
                ...fixture.config,
                scope: {
                  regions: fixture.config.scope?.regions,
                  checkers: {
                    auto: { exclude: ['external/tsconfig.json'] },
                    tsc: { include: ['packages/**/tsconfig.json'] },
                  },
                },
              }
            : fixture.config;
        await expect(prepareGeneratedTsconfigGraph(config)).rejects.toThrow(
          caseValue.expected,
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('rejects hand-maintained references in selected source configs', async () => {
    const fixture = await createFixture({
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/app/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
        references: [
          {
            path: '../core/tsconfig.lib.json',
          },
        ],
      }),
      'packages/core/src/index.ts': 'export const coreValue = 1;\n',
      'packages/core/tsconfig.json': json({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/core/tsconfig.lib.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow('Source typecheck config declares project references');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('reference graph repair compiler differentials', () => {
  it.each([
    'relative-types',
    'relative-types-extends',
    'jsx-runtime',
    'jsx-dev-runtime',
    'vue-direct',
  ])(
    'builds same-package named leaves from inferred references: %s',
    async (variant) => {
      const isVue = variant === 'vue-direct';
      const compilerOptions = {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: isVue,
        types: [],
        jsx: 'preserve',
      };
      const files: Record<string, string> = {
        'packages/p/package.json': json({ name: '@repair/p', type: 'module' }),
        'packages/p/tsconfig.json': json({
          files: [],
          references: [
            { path: './tsconfig.a.json' },
            { path: './tsconfig.b.json' },
          ],
        }),
        'packages/p/tsconfig.a.json': json({
          compilerOptions,
          include: ['a/src/**/*'],
        }),
        'packages/p/tsconfig.b.json': json({
          compilerOptions,
          include: ['b/src/**/*'],
        }),
        'packages/p/a/src/index.ts': 'export const value = 1;',
        'packages/p/b/src/value.ts': 'export interface Value { value: number }',
      };
      if (variant.startsWith('relative-types')) {
        files['packages/p/tsconfig.a.json'] = json({
          compilerOptions: { ...compilerOptions, types: ['./a/env'] },
          include: ['a/src/**/*'],
        });
        files['packages/p/a/env.d.ts'] =
          "import type { Value } from '../b/src/value.js'; declare global { type FromB = Value }";
        files['packages/p/a/src/index.ts'] =
          'export const value: FromB = { value: 1 };';
        if (variant === 'relative-types-extends') {
          files['packages/p/config/base.json'] = json({
            compilerOptions: { ...compilerOptions, types: ['./a/env'] },
          });
          files['packages/p/tsconfig.a.json'] = json({
            extends: './config/base.json',
            include: ['a/src/**/*'],
          });
        }
      } else if (isVue) {
        files['packages/p/a/src/index.ts'] =
          "export { default as Child } from '../../b/src/Child.vue';";
        files['packages/p/b/src/Child.vue'] =
          '<script setup lang="ts">defineProps<{ value?: number }>()</script><template><div /></template>';
      } else {
        delete files['packages/p/a/src/index.ts'];
        files['packages/p/a/src/index.tsx'] = 'export const value = <div />;';
        files['packages/p/tsconfig.a.json'] = json({
          compilerOptions: {
            ...compilerOptions,
            jsx: variant === 'jsx-runtime' ? 'react-jsx' : 'react-jsxdev',
            jsxImportSource: 'repair-runtime',
            paths: { 'repair-runtime/*': ['./b/src/*'] },
          },
          include: ['a/src/**/*'],
        });
        files[`packages/p/b/src/${variant}.ts`] =
          'export const jsx: any = null, jsxs: any = null; export namespace JSX { export interface IntrinsicElements { div: {} } }';
      }
      const fixture = await createFixture(files);
      const fixturePath = createFixturePathResolver(fixture.rootDir);
      const checker = isVue ? 'vue-tsc' : 'tsc';
      fixture.config.scope!.checkers = {
        [checker]: { include: ['packages/**/tsconfig.json'] },
      };
      try {
        if (isVue) {
          const vueRequire = createRequire(
            new URL('../../package.json', import.meta.url),
          );
          await linkInstalledPackage({
            installedName: path.dirname(vueRequire.resolve('vue/package.json')),
            packageName: 'vue',
            rootDir: fixture.rootDir,
          });
        }
        const generated = await prepareGeneratedTsconfigGraph(fixture.config);
        const mapping = generated.sourceToDts.get(checker)!;
        const importer = mapping.get(
          fixturePath('packages/p/tsconfig.a.json'),
        )!;
        const provider = mapping.get(
          fixturePath('packages/p/tsconfig.b.json'),
        )!;
        const config = JSON.parse(await readFile(importer, 'utf8'));
        expect(
          config.references.map((reference: { path: string }) =>
            normalizeAbsolutePath(
              path.resolve(path.dirname(importer), reference.path),
            ),
          ),
        ).toEqual([provider]);
        expect(generated.dependencyEdges).toContainEqual(
          expect.objectContaining({
            fromConfigPath: fixturePath('packages/p/tsconfig.a.json'),
            toConfigPath: fixturePath('packages/p/tsconfig.b.json'),
            kind: 'declaration-provider',
          }),
        );
        const bin = requireFromTest.resolve(
          isVue ? 'vue-tsc/bin/vue-tsc.js' : 'typescript/bin/tsc',
        );
        const build = execFileAsync(
          process.execPath,
          [bin, '-b', importer, '--pretty', 'false', '--force'],
          { cwd: fixture.rootDir },
        );
        await expect(build).resolves.toMatchObject({ stderr: '' });
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );

  it.each(['path', 'types'])(
    'uses the Vue host for a declaration %s directive entry',
    async (kind) => {
      const fixture = await createFixture({
        'packages/a/package.json': json({
          name: '@directive/a',
          type: 'module',
        }),
        'packages/b/package.json': json({
          name: '@directive/b',
          type: 'module',
        }),
        'packages/a/tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
            types: [],
            typeRoots: ['./types'],
          },
          files: ['index.ts', 'App.vue'],
        }),
        'packages/b/tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
            types: [],
          },
          files: ['value.ts'],
        }),
        'packages/a/index.ts':
          kind === 'path'
            ? '/// <reference path="./types/env/index.d.ts" />\nexport {};'
            : '/// <reference types="env" />\nexport {};',
        'packages/a/App.vue':
          '<script setup lang="ts">const value = 1;</script><template>{{value}}</template>',
        'packages/a/types/env/index.d.ts':
          'export type { Value } from "../../../b/value";',
        'packages/b/value.ts': 'export type Value = number;',
      });
      fixture.config.scope!.checkers = {
        'vue-tsc': { include: ['packages/**/tsconfig.json'] },
      };
      try {
        const generated = await prepareGeneratedTsconfigGraph(fixture.config);
        expect(
          generated.dependencyEdges
            .filter(
              (edge) =>
                edge.fromConfigPath ===
                fixture.path('packages/a/tsconfig.json'),
            )
            .map((edge) => edge.toConfigPath),
        ).toEqual([fixture.path('packages/b/tsconfig.json')]);
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );

  it.each(
    ['tsc', 'vue-tsc'].flatMap((checker) =>
      [false, true].map((governed) => ({ checker, governed })),
    ),
  )(
    'projects $checker public declarations with governed=$governed',
    async ({ checker, governed }) => {
      const files: Record<string, string> = {
        'packages/a/package.json': json({ name: '@closure/a', type: 'module' }),
        'packages/bridge/package.json': json({
          name: '@closure/bridge',
          type: 'module',
          types: './index.d.ts',
        }),
        'packages/b/package.json': json({ name: '@closure/b', type: 'module' }),
        'packages/a/tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
            types: [],
          },
          files: [checker === 'tsc' ? 'index.ts' : 'App.vue'],
        }),
        'packages/b/tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
            types: [],
          },
          files: ['value.ts'],
        }),
        'packages/a/index.ts': 'export type { Value } from "@closure/bridge";',
        'packages/bridge/index.d.ts': 'export type { Value } from "./helper";',
        'packages/bridge/helper.d.ts':
          'export type { Value } from "../b/value";',
        'packages/b/value.ts': 'export type Value = number;',
      };
      if (checker === 'vue-tsc')
        files['packages/a/App.vue'] =
          '<script setup lang="ts">import type { Value } from "@closure/bridge"; const value: Value = 1;</script><template>{{value}}</template>';
      if (governed)
        files['packages/bridge/tsconfig.json'] = json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
            types: [],
          },
          files: ['index.d.ts'],
        });
      const fixture = await createFixture(files);
      fixture.config.scope!.checkers = {
        [checker]: { include: ['packages/**/tsconfig.json'] },
      };
      try {
        await mkdir(fixture.path('node_modules/@closure'), { recursive: true });
        await symlink(
          fixture.path('packages/bridge'),
          fixture.path('node_modules/@closure/bridge'),
          'junction',
        );
        const generated = await prepareGeneratedTsconfigGraph(fixture.config);
        const edges = generated.dependencyEdges.filter(
          (edge) =>
            edge.fromConfigPath === fixture.path('packages/a/tsconfig.json'),
        );
        expect(edges.map((edge) => edge.toConfigPath)).toEqual(
          governed ? [fixture.path('packages/bridge/tsconfig.json')] : [],
        );
        expect(
          edges.every((edge) => edge.kind === 'declaration-provider'),
        ).toBe(true);
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );

  async function createFrameworkRequirementFixture(
    framework: string,
    kind: string,
  ) {
    const files: Record<string, string> = {
      'packages/a/package.json': json({
        name: '@repair/a',
        type: 'module',
        dependencies:
          framework === 'astro'
            ? {
                ...readAstroTestToolchain(requireFromTest).dependencies,
              }
            : { svelte: '4.0.0', svelte2tsx: '0.7.61', typescript: '6.0.3' },
      }),
      'packages/b/package.json': json({ name: '@repair/b', type: 'module' }),
      'packages/a/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
          types: [],
        },
        include: ['src/**/*'],
      }),
      'packages/b/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
          types: [],
        },
        include: ['src/**/*'],
      }),
      [`packages/a/src/Entry.${framework}`]:
        framework === 'svelte'
          ? '<script lang="ts">import type { Value } from "../../b/src/value.js"; let value: Value = 1;</script><p>{value}</p>'
          : '---\nimport type { Value } from "../../b/src/value.js"; const value: Value = 1;\n---\n<p>{value}</p>',
      'packages/b/src/value.d.ts': 'export type Value = number;',
    };
    if (kind === 'ambient-membership') {
      delete files['packages/b/src/value.d.ts'];
      files['packages/b/src/value.ts'] =
        'export type Value = { source: true };';
      files[`packages/a/src/Entry.${framework}`] = '<p>Component</p>';
      files['packages/a/src/index.ts'] =
        "import type { Value } from 'dep'; export const value: Value = 1;";
      files['packages/a/src/env.d.ts'] =
        "declare module 'dep' { export type Value = number; }";
      const config = JSON.parse(files['packages/a/tsconfig.json']!);
      config.compilerOptions.paths = { dep: ['../b/src/value.ts'] };
      files['packages/a/tsconfig.json'] = json(config);
    }
    if (kind.startsWith('support-')) {
      delete files['packages/b/src/value.d.ts'];
      files['packages/b/src/value.ts'] = 'export type Value = number;';
      files['packages/a/src/env.d.ts'] =
        kind === 'support-module'
          ? 'import type { Value } from "../../b/src/value"; export type Support = Value;'
          : '/// <reference path="../../b/src/value.ts" />\nexport type Support = number;';
      files[`packages/a/src/Entry.${framework}`] =
        framework === 'svelte'
          ? '<script lang="ts">import type { Support } from "./env"; let value: Support = 1;</script><p>{value}</p>'
          : '---\nimport type { Support } from "./env"; const value: Support = 1;\n---\n<p>{value}</p>';
      const config = JSON.parse(files['packages/a/tsconfig.json']!);
      delete config.include;
      config.files = [`src/Entry.${framework}`];
      files['packages/a/tsconfig.json'] = json(config);
    }
    if (kind.startsWith('support-public')) {
      files['packages/bridge/package.json'] = json({
        name: '@closure/bridge',
        type: 'module',
        types: './index.d.ts',
      });
      files['packages/bridge/index.d.ts'] =
        'export type { Support } from "./helper";';
      files['packages/bridge/helper.d.ts'] =
        'export type { Value as Support } from "../b/src/value";';
      files[`packages/a/src/Entry.${framework}`] = files[
        `packages/a/src/Entry.${framework}`
      ]!.replace('./env', '@closure/bridge');
      if (kind === 'support-public-governed')
        files['packages/bridge/tsconfig.json'] = json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
            types: [],
          },
          files: ['index.d.ts'],
        });
      else if (kind === 'support-public-local') {
        files['packages/a/src/env.d.ts'] =
          'export type { Support } from "../../bridge/index";';
        const config = JSON.parse(files['packages/a/tsconfig.json']!);
        config.files.push('src/env.d.ts');
        files['packages/a/tsconfig.json'] = json(config);
      }
    }
    const fixture = await createFixture(files);
    fixture.config.scope!.checkers = {
      [framework === 'svelte' ? 'svelte-check' : 'astro']: {
        include: ['packages/a/tsconfig.json'],
      },
      tsc: { include: ['packages/b/tsconfig.json'] },
    };
    try {
      if (kind.startsWith('support-public')) {
        await mkdir(fixture.path('node_modules/@closure'), {
          recursive: true,
        });
        await symlink(
          fixture.path('packages/bridge'),
          fixture.path('node_modules/@closure/bridge'),
          'junction',
        );
        if (kind === 'support-public-governed')
          fixture.config.scope!.checkers!.tsc = {
            include: [
              'packages/b/tsconfig.json',
              'packages/bridge/tsconfig.json',
            ],
          };
      }
      const leafRoot = path.join(fixture.rootDir, 'packages/a');
      if (framework === 'astro') await linkAstroToolchain(leafRoot);
      else {
        await linkInstalledPackage({
          installedName: 'svelte-v4-min',
          packageName: 'svelte',
          rootDir: leafRoot,
        });
        await linkInstalledPackage({
          installedName: 'svelte2tsx',
          packageName: 'svelte2tsx',
          rootDir: leafRoot,
        });
        await linkInstalledPackage({
          installedName: 'typescript',
          packageName: 'typescript',
          rootDir: leafRoot,
        });
      }
      return fixture;
    } catch (error) {
      await fixture.cleanup();
      throw error;
    }
  }

  it.each(
    ['svelte', 'astro'].flatMap((framework) =>
      [
        'declaration',
        'ambient-membership',
        'support-module',
        'support-path',
        'support-public',
        'support-public-governed',
        'support-public-local',
      ].map((kind) => ({
        framework,
        kind,
      })),
    ),
  )(
    'governs $framework $kind evidence with its actual source requirement',
    async ({ framework, kind }) => {
      const fixture = await createFrameworkRequirementFixture(framework, kind);
      try {
        const generated = await prepareGeneratedTsconfigGraph(fixture.config);
        if (kind === 'support-public')
          expect(generated.dependencyEdges).toEqual([]);
        else if (kind === 'ambient-membership' || kind.startsWith('support-')) {
          expect(
            generated.dependencyEdges.filter(
              (edge) =>
                edge.fromConfigPath ===
                fixture.path('packages/a/tsconfig.json'),
            ),
          ).toEqual([
            expect.objectContaining({
              fromConfigPath: fixture.path('packages/a/tsconfig.json'),
              toConfigPath: fixture.path('packages/b/tsconfig.json'),
              kind: 'framework-schedule',
            }),
          ]);
          const source = generated.governedSources
            .values()
            .flatMap((units) => units.values())
            .find(
              (unit) =>
                unit.configPath === fixture.path('packages/a/tsconfig.json'),
            )!;
          if (kind !== 'support-public-local' && kind.startsWith('support-'))
            expect(source.ownedFileNames).toEqual([
              fixture.path(`packages/a/src/Entry.${framework}`),
            ]);
        } else expect(generated.dependencyEdges).toEqual([]);
        if (kind === 'ambient-membership') {
          expect(generated.ownershipPlan.dependencyFacts).toContainEqual(
            expect.objectContaining({
              typeEvidenceKind: 'unobserved',
              referenceRequirement: expect.objectContaining({
                kind: 'compiler-membership',
              }),
            }),
          );
        }
      } finally {
        await fixture.cleanup();
      }
    },
  );

  // Keep the standalone compiler control within its own unchanged case budget.
  it.each(['svelte', 'astro'])(
    'compiles %s ambient membership independently of graph preparation',
    async (framework) => {
      const fixture = await createFrameworkRequirementFixture(
        framework,
        'ambient-membership',
      );
      try {
        const result = await execFileAsync(
          process.execPath,
          [
            requireFromTest.resolve('typescript/bin/tsc'),
            '-p',
            fixture.path('packages/a/tsconfig.json'),
            '--noEmit',
            '--pretty',
            'false',
          ],
          { cwd: fixture.rootDir },
        );
        expect(result.stderr).toBe('');
      } finally {
        await fixture.cleanup();
      }
    },
  );
});

describe('ambient references and compiler membership', () => {
  it.each(['type-only', 'dynamic', 'cjs', 'paths', 'augmentation'])(
    'keeps external and augmentation obligations separate from actual compiler builds: %s',
    async (variant) => {
      const isMembership = variant === 'paths' || variant === 'augmentation';
      const extension = variant === 'cjs' ? 'cts' : 'ts';
      const compilerOptions = {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        strict: true,
        noEmit: true,
        types: [],
      };
      const code =
        variant === 'dynamic'
          ? "export async function answer(): Promise<true> { const b = await import('@repair/b'); return b.value.ambient; }"
          : "type B = import('@repair/b').B; const b: B = { ambient: true }; export const answer: true = b.ambient;";
      const fixture = await createFixture({
        'packages/a/package.json': json({ name: '@repair/a', type: 'module' }),
        'packages/b/package.json': json({
          name: '@repair/b',
          type: 'module',
          exports: './src/value.ts',
        }),
        'packages/a/tsconfig.json': json({
          compilerOptions: {
            ...compilerOptions,
            paths: isMembership
              ? { '@repair/b': ['../b/src/value.ts'] }
              : undefined,
          },
          include: ['src/**/*'],
        }),
        'packages/b/tsconfig.json': json({
          compilerOptions,
          include: ['src/**/*'],
        }),
        [`packages/a/src/index.${extension}`]: code,
        'packages/a/src/env.d.ts': `${variant === 'augmentation' ? "import '@repair/b';" : ''}declare module '@repair/b' { export interface B { ambient: true } export const value: { ambient: true } }`,
        'packages/b/src/value.ts': isMembership
          ? 'export interface B {}'
          : `import type { answer } from '../../a/src/index.${extension === 'cts' ? 'cjs' : 'js'}'; export interface B { physical: true } export type Answer = typeof answer;`,
      });
      const fixturePath = createFixturePathResolver(fixture.rootDir);
      try {
        await linkWorkspacePackage(
          fixture.rootDir,
          'packages/a',
          'packages/b',
          '@repair/b',
        );
        const generated = await prepareGeneratedTsconfigGraph(fixture.config);
        const pair = [
          fixturePath(`packages/${isMembership ? 'a' : 'b'}/tsconfig.json`),
          fixturePath(`packages/${isMembership ? 'b' : 'a'}/tsconfig.json`),
        ];
        expect(
          generated.dependencyEdges.map((edge) => [
            edge.fromConfigPath,
            edge.toConfigPath,
          ]),
        ).toEqual(
          variant === 'augmentation'
            ? [pair, pair]
            : isMembership
              ? [pair]
              : [pair],
        );
        const facts = generated.ownershipPlan.dependencyFacts.filter(
          (fact) =>
            fact.consumerConfigPath === fixturePath('packages/a/tsconfig.json'),
        );
        expect(facts).toHaveLength(variant === 'augmentation' ? 3 : 1);
        for (const fact of facts) {
          expect(fact.typeEvidenceKind).toBe('unobserved');
          const obligation = fact.nativeEvidence!.obligation!;
          expect(fact.referenceRequirement?.kind).toBe(
            obligation.existence.state === 'present'
              ? 'compiler-membership'
              : undefined,
          );
        }
        const importer = generated.sourceToDts
          .get('tsc')!
          .get(
            fixturePath(`packages/${isMembership ? 'a' : 'b'}/tsconfig.json`),
          )!;
        const build = execFileAsync(
          process.execPath,
          [
            requireFromTest.resolve('typescript/bin/tsc'),
            '-b',
            importer,
            '--pretty',
            'false',
            '--force',
          ],
          { cwd: fixture.rootDir },
        );
        await expect(build).resolves.toMatchObject({ stderr: '' });
      } finally {
        await fixture.cleanup();
      }
    },
  );
  it('keeps colliding config basenames in distinct declaration and cache scopes', async () => {
    const fixture = await createFixture({
      'packages/pkg/tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['a'],
      }),
      'packages/pkg/tsconfig.tsconfig.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['b'],
      }),
      'packages/pkg/a/index.ts': 'export const a = 1;',
      'packages/pkg/b/index.ts': 'export const b = 2;',
      'packages/solution/tsconfig.json': json({
        files: [],
        references: [
          { path: '../pkg/tsconfig.json' },
          { path: '../pkg/tsconfig.tsconfig.json' },
        ],
      }),
    });
    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);
      const generated = result.sourceToDts.get('tsc')!;
      const projects = ['tsconfig.json', 'tsconfig.tsconfig.json'].map((name) =>
        parseProject(
          fixture.config,
          generated.get(fixture.path('packages/pkg', name))!,
        ),
      );
      expect(
        new Set(projects.map((project) => project.options.outDir)).size,
      ).toBe(2);
      expect(
        new Set(projects.map((project) => project.options.tsBuildInfoFile))
          .size,
      ).toBe(2);
      expect(projects[0]!.options.outDir).toBe(
        fixture.path('.limina/dts/checkers/tsc/packages/pkg/tsconfig.json'),
      );
      expect(projects[1]!.options.outDir).toBe(
        fixture.path(
          '.limina/dts/checkers/tsc/packages/pkg/tsconfig.tsconfig.json',
        ),
      );
      const repeated = await prepareGeneratedTsconfigGraph(fixture.config);
      expect(repeated.changed).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('regenerates scopes while cleaning only paths in the old ownership ledger', async () => {
    const owned = 'tsbuildinfo/checkers/tsc/packages/pkg/lib.tsbuildinfo';
    const unknown = '.limina/dts/checkers/tsc/packages/pkg/lib/user.txt';
    const fixture = await createFixture({
      '.limina/manifest.json': json({
        generatedBy: 'limina',
        version: 6,
        ownedArtifacts: [owned, 'manifest.json'],
      }),
      [`.limina/${owned}`]: 'old managed cache',
      [unknown]: 'preserve me',
      'packages/pkg/tsconfig.json': json({
        files: [],
        references: [{ path: './tsconfig.lib.json' }],
      }),
      'packages/pkg/tsconfig.lib.json': json({
        compilerOptions: managedOutputCompilerOptions(),
        include: ['src'],
      }),
      'packages/pkg/src/index.ts': 'export const value = 1;',
    });
    try {
      const graph = await prepareGeneratedTsconfigGraph(fixture.config);
      expect(existsSync(fixture.path('.limina', owned))).toBe(false);
      expect(await readFile(fixture.path(unknown), 'utf8')).toBe('preserve me');
      const generated = graph.sourceToDts
        .get('tsc')!
        .get(fixture.path('packages/pkg/tsconfig.lib.json'))!;
      expect(parseProject(fixture.config, generated).options.outDir).toBe(
        fixture.path('.limina/dts/checkers/tsc/packages/pkg/tsconfig.lib.json'),
      );
      expect(
        (await prepareGeneratedTsconfigGraph(fixture.config)).changed,
      ).toBe(false);
      expect(await readFile(fixture.path(unknown), 'utf8')).toBe('preserve me');
    } finally {
      await fixture.cleanup();
    }
  });
  it.each([
    'relative',
    'inherited-relative',
    'named-auto-roots',
    'explicit-roots',
  ])(
    'preserves source type inputs in declaration and output projections: %s',
    async (variant) => {
      const isNamed = variant.endsWith('roots');
      const compilerOptions = {
        ...managedOutputCompilerOptions(),
        types: [isNamed ? 'fixture' : './env'],
        ...(variant === 'explicit-roots' && {
          typeRoots: ['./node_modules/@types'],
        }),
      };
      const files = {
        'packages/pkg/tsconfig.json': json({
          ...(variant === 'inherited-relative'
            ? { extends: './config/base.json' }
            : { compilerOptions }),
          include: ['src'],
          liminaOptions: { outputs: { rootDir: './src' } },
        }),
        'packages/pkg/config/base.json': json({ compilerOptions }),
        'packages/pkg/env.d.ts': 'declare const AmbientValue: number;',
        'packages/pkg/node_modules/@types/fixture/package.json': json({
          name: '@types/fixture',
          version: '1.0.0',
          types: 'index.d.ts',
        }),
        'packages/pkg/node_modules/@types/fixture/index.d.ts':
          'declare const AmbientValue: number;',
        'packages/pkg/src/index.ts': 'export const value = AmbientValue;',
      };
      const fixture = await createFixture(files);
      try {
        const source = fixture.path('packages/pkg/tsconfig.json');
        const sourceProject = parseProject(fixture.config, source);
        const sourceProgram = ts.createProgram({
          rootNames: sourceProject.fileNames,
          options: { ...sourceProject.options, noEmit: true },
        });
        expect(ts.getPreEmitDiagnostics(sourceProgram)).toEqual([]);
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        const configs = [
          graph.sourceToDts.get('tsc')!.get(source)!,
          graph.configToOutputBuild.get('tsc')!.get(source)!.path,
        ];
        for (const configPath of configs) {
          const config = JSON.parse(await readFile(configPath, 'utf8'));
          expect(config.compilerOptions.types).toEqual([
            isNamed ? 'fixture' : fixture.path('packages/pkg/env.d.ts'),
          ]);
          const parsed = parseProject(fixture.config, configPath);
          expect(parsed.fileNames).not.toContain(
            fixture.path('packages/pkg/env.d.ts'),
          );
          expect(parsed.options.typeRoots).toContain(
            fixture.path('packages/pkg/node_modules/@types'),
          );
        }
        const build = ts.createSolutionBuilder(
          ts.createSolutionBuilderHost(ts.sys),
          configs,
          { force: true },
        );
        expect(build.build()).toBe(0);
        expect(
          await readGeneratedIndexDeclaration(
            fixture.path('.limina/dts/checkers/tsc/packages/pkg/tsconfig.json'),
          ),
        ).toContain('value: number');
        expect(
          await readFile(fixture.path('packages/pkg/dist/index.d.ts'), 'utf8'),
        ).toContain('value: number');
      } finally {
        await fixture.cleanup();
      }
    },
  );
  it.each(['local', 'hoisted-extends', 'explicit-roots', 'mixed-names'])(
    'keeps wildcard type enumeration at the source config: %s',
    async (variant) => {
      const dependencyRoot =
        variant === 'hoisted-extends' ? '' : 'packages/pkg/';
      const isMixed = variant === 'mixed-names';
      const compilerOptions = {
        ...managedOutputCompilerOptions(),
        types: isMixed ? ['*', 'tools/client', './env'] : ['*'],
        ...(variant === 'explicit-roots' && {
          typeRoots: ['./node_modules/@types'],
        }),
      };
      const fixture = await createFixture({
        'packages/pkg/tsconfig.json': json({
          ...(variant === 'hoisted-extends'
            ? { extends: '../../base.json' }
            : { compilerOptions }),
          include: ['src'],
          liminaOptions: { outputs: { rootDir: './src' } },
        }),
        'base.json': json({ compilerOptions }),
        [`${dependencyRoot}node_modules/@types/fixture/package.json`]: json({
          name: '@types/fixture',
          version: '1.0.0',
          types: 'index.d.ts',
        }),
        [`${dependencyRoot}node_modules/@types/fixture/index.d.ts`]:
          'declare const AmbientValue: number;',
        [`${dependencyRoot}node_modules/ordinary/package.json`]: json({
          name: 'ordinary',
          version: '1.0.0',
          main: 'index.js',
        }),
        [`${dependencyRoot}node_modules/ordinary/index.js`]:
          'exports.value = 1;',
        'packages/pkg/node_modules/tools/package.json': json({
          name: 'tools',
          version: '1.0.0',
        }),
        'packages/pkg/node_modules/tools/client.d.ts':
          'declare const NamedValue: number;',
        'packages/pkg/env.d.ts': 'declare const RelativeValue: number;',
        'packages/pkg/src/index.ts': isMixed
          ? 'export const value = AmbientValue + NamedValue + RelativeValue;'
          : 'export const value = AmbientValue;',
      });
      try {
        const source = fixture.path('packages/pkg/tsconfig.json');
        const sourceProject = parseProject(fixture.config, source);
        const sourceProgram = ts.createProgram({
          rootNames: sourceProject.fileNames,
          options: { ...sourceProject.options, noEmit: true },
        });
        expect(ts.getPreEmitDiagnostics(sourceProgram)).toEqual([]);
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        const configs = [
          graph.sourceToDts.get('tsc')!.get(source)!,
          graph.configToOutputBuild.get('tsc')!.get(source)!.path,
        ];
        for (const configPath of configs) {
          const projected = JSON.parse(await readFile(configPath, 'utf8'));
          expect(projected.compilerOptions.types).toEqual(
            isMixed
              ? [
                  'fixture',
                  'tools/client',
                  fixture.path('packages/pkg/env.d.ts'),
                ]
              : ['fixture'],
          );
        }
        const build = ts.createSolutionBuilder(
          ts.createSolutionBuilderHost(ts.sys),
          configs,
          { force: true },
        );
        expect(build.build()).toBe(0);
        expect(
          await readGeneratedIndexDeclaration(
            fixture.path('.limina/dts/checkers/tsc/packages/pkg/tsconfig.json'),
          ),
        ).toContain('value: number');
        expect(
          await readFile(fixture.path('packages/pkg/dist/index.d.ts'), 'utf8'),
        ).toContain('value: number');
      } finally {
        await fixture.cleanup();
      }
    },
  );
  it.each(['import', 'path', 'physical', 'bare'] as const)(
    'preserves external type entry loading identity: %s',
    async (variant) => {
      const compilerOptions = {
        composite: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        target: 'ES2020',
        rootDir: '.',
        types: [],
      };
      const fixture = await createFixture({
        'tsconfig.json': json({
          files: [],
          references: [{ path: './a' }, { path: './b' }],
        }),
        'a/tsconfig.json': json({
          compilerOptions: {
            ...compilerOptions,
            types: [
              variant === 'bare'
                ? 'env/index'
                : './node_modules/env/index.d.ts',
            ],
          },
          files: ['index.ts'],
        }),
        'b/tsconfig.json': json({ compilerOptions, files: ['index.ts'] }),
        'a/index.ts': 'export const value: number = 1;',
        'b/index.ts': 'export interface Value { value: number }',
      });
      fixture.config.scope!.checkers = { tsc: { include: ['tsconfig.json'] } };
      try {
        const target = variant === 'physical' ? 'a/node_modules/env' : 'vendor';
        await writeText(
          fixture.path(target, 'index.d.ts'),
          variant === 'path'
            ? `/// <reference path="${fixture.path('b/index.ts')}" />\nexport {};`
            : `import type { Value } from '${fixture.path('b/index')}'; export type Ambient = Value;`,
        );
        if (variant !== 'physical') {
          await mkdir(fixture.path('a/node_modules'), { recursive: true });
          await symlink(
            fixture.path('vendor'),
            fixture.path('a/node_modules/env'),
            'junction',
          );
        }
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        const generated = graph.sourceToDts
          .get('tsc')!
          .get(fixture.path('a/tsconfig.json'))!;
        expect(graph.dependencyEdges).toEqual([]);
        const parsed = parseProject(fixture.config, generated);
        const program = ts.createProgram({
          rootNames: parsed.fileNames,
          options: parsed.options,
        });
        const importedSource = program.getSourceFile(
          fixture.path('b/index.ts'),
        )!;
        expect(program.isSourceFileFromExternalLibrary(importedSource)).toBe(
          true,
        );
        expect(
          ts
            .createSolutionBuilder(
              ts.createSolutionBuilderHost(ts.sys),
              [generated],
              { force: true },
            )
            .build(),
        ).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(['direct', 'inherited', 'base-url', 'relative'] as const)(
    'preserves relocated config path semantics: %s',
    async (variant) => {
      const compilerOptions = {
        composite: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        target: 'ES2020',
        types: [],
        ignoreDeprecations: '6.0',
      };
      const paths = {
        '@dep': [
          variant === 'relative' ? './b/index.ts' : '${configDir}/b/index.ts',
          variant === 'inherited' ? '../c/index.ts' : './c/index.ts',
        ],
      };
      const fixture = await createFixture({
        'tsconfig.json': json({
          files: [],
          references: ['a', 'b', 'c'].map((name) => ({
            path: `./tsconfig.${name}.json`,
          })),
        }),
        'shared/base.json': json({ compilerOptions: { paths } }),
        'tsconfig.a.json': json({
          ...(variant === 'inherited' && { extends: './shared/base.json' }),
          compilerOptions: {
            ...compilerOptions,
            rootDir: './a',
            ...(variant === 'base-url'
              ? {
                  baseUrl: '${configDir}',
                  paths: { '@dep': ['./b/index.ts', './c/index.ts'] },
                }
              : variant === 'inherited'
                ? {}
                : { paths }),
          },
          files: ['a/index.ts'],
          liminaOptions: { outputs: { rootDir: './a', outDir: './out/a' } },
        }),
        ...Object.fromEntries(
          ['b', 'c'].map((name) => [
            `tsconfig.${name}.json`,
            json({
              compilerOptions: { ...compilerOptions, rootDir: `./${name}` },
              files: [`${name}/index.ts`],
              liminaOptions: {
                outputs: { rootDir: `./${name}`, outDir: `./out/${name}` },
              },
            }),
          ]),
        ),
        'a/index.ts': 'export { value } from "@dep";',
        'b/index.ts': 'export const value: number = 1;',
        'c/index.ts': 'export const value: string = "wrong provider";',
      });
      fixture.config.scope!.checkers = { tsc: { include: ['tsconfig.json'] } };
      try {
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        const source = fixture.path('tsconfig.a.json');
        expect(graph.dependencyEdges.map((edge) => edge.toConfigPath)).toEqual([
          fixture.path('tsconfig.b.json'),
        ]);
        const configs = [
          graph.sourceToDts.get('tsc')!.get(source)!,
          graph.configToOutputBuild.get('tsc')!.get(source)!.path,
        ];
        expect(
          ts
            .createSolutionBuilder(
              ts.createSolutionBuilderHost(ts.sys),
              configs,
              { force: true },
            )
            .build(),
        ).toBe(0);
        expect(
          await readFile(fixture.path('out/a/index.d.ts'), 'utf8'),
        ).toContain('@dep');
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(['unknown', 'implementation', 'same-target', 'unowned'] as const)(
    'admits output-only obligations by candidate impact: %s',
    async (variant) => {
      const extension = variant === 'implementation' ? 'ts' : 'json';
      const compilerOptions = {
        composite: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        target: 'ES2020',
        types: [],
        resolveJsonModule: true,
        libReplacement: true,
        rootDir: './src',
      };
      const fixture = await createFixture({
        'tsconfig.json': json({
          files: [],
          references: [
            { path: './tsconfig.a.json' },
            ...(variant === 'unowned' ? [] : [{ path: './tsconfig.b.json' }]),
          ],
        }),
        'tsconfig.a.json': json({
          compilerOptions,
          files: ['src/a.ts'],
          liminaOptions: {
            outputs: {
              target: variant === 'same-target' ? 'ES2020' : 'ES2022',
              rootDir: './src',
              outDir: './out/a',
            },
          },
        }),
        'tsconfig.b.json': json({
          compilerOptions,
          files: [`src/value.${extension}`],
          liminaOptions: {
            outputs: { target: 'ES2020', rootDir: './src', outDir: './out/b' },
          },
        }),
        'src/a.ts': 'export const a = 1;',
        [`src/value.${extension}`]:
          extension === 'ts' ? 'export default 1;' : '{"value":1}',
        'node_modules/@typescript/lib-es2022/package.json': json({
          name: '@typescript/lib-es2022',
          types: '../../../library/es2022.d.ts',
        }),
        'library/es2022.d.ts': `/// <reference lib="es2020" />\nimport value from '../src/value.${extension}'; export type Value = typeof value;`,
      });
      fixture.config.scope!.checkers = { tsc: { include: ['tsconfig.json'] } };
      try {
        const preparation = prepareGeneratedTsconfigGraph(fixture.config);
        if (variant === 'unknown')
          await expect(preparation).rejects.toThrow(
            'Unproved output compilation relation',
          );
        else if (variant === 'implementation')
          await expect(preparation).rejects.toThrow(
            'not covered by existing output references',
          );
        else expect((await preparation).dependencyEdges).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([
    {
      sourceTarget: 'ES2022',
      outputTarget: 'ES2020',
      lib: undefined,
      same: false,
    },
    {
      sourceTarget: 'ES2022',
      outputTarget: 'ES2022',
      lib: undefined,
      same: true,
    },
    {
      sourceTarget: 'ES2022',
      outputTarget: 'ES2020',
      lib: ['ES2022'],
      same: true,
    },
    {
      sourceTarget: undefined,
      outputTarget: undefined,
      lib: undefined,
      same: false,
    },
  ])(
    'preserves legal output target library differences: $sourceTarget -> $outputTarget',
    async ({ sourceTarget, outputTarget, lib, same }) => {
      const fixture = await createFixture({
        'packages/pkg/tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
            types: [],
            target: sourceTarget,
            lib,
          },
          files: ['src/index.ts'],
          liminaOptions: {
            outputs: { rootDir: './src', target: outputTarget },
          },
        }),
        'packages/pkg/src/index.ts': 'export const value=1;',
      });
      try {
        const source = fixture.path('packages/pkg/tsconfig.json');
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        const configs = [
          graph.sourceToDts.get('tsc')!.get(source)!,
          graph.configToOutputBuild.get('tsc')!.get(source)!.path,
        ];
        const libs = (configPath: string) => {
          const parsed = parseProject(fixture.config, configPath);
          return ts
            .createProgram({
              rootNames: parsed.fileNames,
              options: parsed.options,
            })
            .getSourceFiles()
            .filter((file) => /lib\.[^/]+\.d\.ts$/.test(file.fileName))
            .map((file) => path.basename(file.fileName))
            .sort(compareCodeUnits);
        };
        expect(
          JSON.stringify(libs(source)) === JSON.stringify(libs(configs[1])),
        ).toBe(same);
        expect(graph.dependencyEdges).toEqual([]);
        expect(
          graph.typeInputProjections?.every(
            (receipt) =>
              receipt.scope === 'config-type-directives' &&
              receipt.source.length === 0,
          ),
        ).toBe(true);
        expect(
          ts
            .createSolutionBuilder(
              ts.createSolutionBuilderHost(ts.sys),
              configs,
              { force: true },
            )
            .build(),
        ).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
  );
  it.each(['relative', 'inherited-relative', 'absolute'])(
    'preserves uncovered typeRoots inputs for the final Checker: %s',
    async (variant) => {
      const compilerOptions = {
        ...managedOutputCompilerOptions(),
        types: ['./env'],
        typeRoots: ['./types'],
      };
      const fixture = await createFixture({
        'packages/a/package.json': json({ name: '@example/a', private: true }),
        'packages/b/package.json': json({ name: '@example/b', private: true }),
        'packages/c/package.json': json({ name: '@example/c', private: true }),
        'packages/a/tsconfig.json': json({
          ...(variant === 'inherited-relative'
            ? { extends: './base.json' }
            : { compilerOptions }),
          files: ['src/index.ts'],
          liminaOptions: { outputs: { rootDir: './src' } },
        }),
        'packages/a/base.json': json({ compilerOptions }),
        'packages/a/src/index.ts': 'export const value = 1;',
        'packages/a/env.d.ts':
          'import type { Value } from "../b/src/index"; export declare const value: Value;',
        'packages/a/types/env/index.d.ts':
          'import type { Value } from "../../../c/src/index"; export declare const value: Value;',
        ...Object.fromEntries(
          ['b', 'c'].flatMap((name) => [
            [
              `packages/${name}/tsconfig.json`,
              json({
                compilerOptions: managedOutputCompilerOptions(),
                files: ['src/index.ts'],
                liminaOptions: { outputs: { rootDir: './src' } },
              }),
            ],
            [
              `packages/${name}/src/index.ts`,
              'export interface Value { value: number }',
            ],
          ]),
        ),
      });
      try {
        const source = fixture.path('packages/a/tsconfig.json');
        if (variant === 'absolute') {
          await writeText(
            source,
            json({
              compilerOptions: {
                ...compilerOptions,
                types: [fixture.path('packages/a/env.d.ts')],
              },
              files: ['src/index.ts'],
              liminaOptions: { outputs: { rootDir: './src' } },
            }),
          );
        }
        const selected = fixture.path(
          variant === 'absolute'
            ? 'packages/a/env.d.ts'
            : 'packages/a/types/env/index.d.ts',
        );
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        expect(
          graph.dependencyEdges
            .filter((edge) => edge.fromConfigPath === source)
            .map((edge) => edge.toConfigPath),
        ).toEqual([
          fixture.path(
            variant === 'absolute'
              ? 'packages/b/tsconfig.json'
              : 'packages/c/tsconfig.json',
          ),
        ]);
        const configs = [
          graph.sourceToDts.get('tsc')!.get(source)!,
          graph.configToOutputBuild.get('tsc')!.get(source)!.path,
        ];
        for (const configPath of configs) {
          const receipt = graph.typeInputProjections!.find(
            (value) => value.generatedConfig === configPath,
          )!;
          expect(receipt.source.map((entry) => entry.target)).toEqual([
            selected,
          ]);
          expect(receipt.generated.map((entry) => entry.target)).toEqual([
            selected,
          ]);
          const parsed = parseProject(fixture.config, configPath);
          expect(parsed.fileNames).toEqual([
            fixture.path('packages/a/src/index.ts'),
          ]);
          expect(parsed.options.typeRoots).toEqual([
            fixture.path('packages/a/types'),
          ]);
        }
        const diagnostics: ts.Diagnostic[] = [];
        const host = ts.createSolutionBuilderHost(
          ts.sys,
          undefined,
          (diagnostic) => {
            diagnostics.push(diagnostic);
          },
        );
        expect(
          ts.createSolutionBuilder(host, configs, { force: true }).build(),
        ).toBe(0);
        expect(diagnostics).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
  );
  it('keeps a source type miss despite an unrelated declaration beside generated configs', async () => {
    const fixture = await createFixture({
      'packages/a/tsconfig.json': json({
        compilerOptions: { ...managedOutputCompilerOptions(), types: [] },
        files: ['src/index.ts'],
      }),
      'packages/a/src/index.ts': 'export const value = 1;',
    });
    try {
      const source = fixture.path('packages/a/tsconfig.json');
      const graph = await prepareGeneratedTsconfigGraph(fixture.config);
      const generated = graph.sourceToDts.get('tsc')!.get(source)!;
      await writeText(
        path.join(path.dirname(generated), 'env.d.ts'),
        'export interface Unrelated {}',
      );
      await writeText(
        source,
        json({
          compilerOptions: {
            ...managedOutputCompilerOptions(),
            types: ['./env'],
            typeRoots: [],
          },
          files: ['src/index.ts'],
        }),
      );
      const preserved = await prepareGeneratedTsconfigGraph(fixture.config);
      const receipt = preserved.typeInputProjections!.find(
        (value) => value.sourceConfig === source,
      )!;
      expect(receipt.source.map((value) => value.target)).toEqual([null]);
      expect(receipt.generated.map((value) => value.target)).toEqual([null]);
    } finally {
      await fixture.cleanup();
    }
  });
  it.each([
    {
      sourceTarget: 'ES2023',
      outputTarget: 'ES2020',
      component: false,
      missingRelation: false,
    },
    {
      sourceTarget: 'ES2020',
      outputTarget: 'ES2023',
      component: true,
      missingRelation: false,
    },
    {
      sourceTarget: 'ES2023',
      outputTarget: 'ES2020',
      component: true,
      missingRelation: true,
    },
  ])(
    'validates Vue output with $sourceTarget -> $outputTarget (component=$component, missingRelation=$missingRelation)',
    async ({ sourceTarget, outputTarget, component, missingRelation }) => {
      const compilerOptions = {
        ...managedOutputCompilerOptions(),
        target: sourceTarget,
        skipLibCheck: true,
      };
      const fixture = await createFixture({
        'packages/a/package.json': json({ name: '@output/a', type: 'module' }),
        'packages/b/package.json': json({ name: '@output/b', type: 'module' }),
        'packages/a/tsconfig.json': json({
          compilerOptions,
          include: ['src/**/*'],
          liminaOptions: { outputs: { rootDir: 'src', target: outputTarget } },
        }),
        'packages/b/tsconfig.json': json({
          compilerOptions,
          files: ['src/value.ts'],
          liminaOptions: { outputs: { rootDir: 'src', target: outputTarget } },
        }),
        'packages/b/src/value.ts': 'export const value: number = 1;',
        [component ? 'packages/a/src/App.vue' : 'packages/a/src/index.ts']:
          component
            ? '<script setup lang="ts">import {value} from "../../b/src/value.js";</script><template>{{value}}</template>'
            : 'export {value} from "../../b/src/value.js";',
      });
      fixture.config.scope!.checkers = {
        'vue-tsc': { include: ['packages/**/tsconfig.json'] },
      };
      try {
        await linkInstalledPackage({
          installedName: 'vue',
          packageName: 'vue',
          rootDir: fixture.rootDir,
        });
        if (missingRelation) {
          const createOutput =
            generatedConfigs.createGeneratedOutputProjectConfig;
          vi.spyOn(
            generatedConfigs,
            'createGeneratedOutputProjectConfig',
          ).mockImplementation((options) => {
            options.project.outputReferences.clear();
            return createOutput(options);
          });
          const preparation = prepareGeneratedTsconfigGraph(fixture.config);
          await expect(preparation).rejects.toThrow(
            'an output dependency is not covered by existing output references',
          );
          await expect(preparation).rejects.toMatchObject({
            analysis: {
              outcome: {
                execution: 'completed',
                graphTransaction: { state: 'failed' },
                governance: { state: 'compliant', diagnostics: [] },
                buildAdmission: { state: 'unavailable' },
              },
            },
          });
          return;
        }
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        const source = fixture.path('packages/a/tsconfig.json');
        const output = graph.configToOutputBuild
          .get('vue-tsc')!
          .get(source)!.path;
        const parsed = parseProject(fixture.config, output);
        expect(parsed.options.target).toBe(
          ts.ScriptTarget[outputTarget as 'ES2020' | 'ES2023'],
        );
        expect(graph.dependencyEdges).toContainEqual(
          expect.objectContaining({
            fromConfigPath: source,
            toConfigPath: fixture.path('packages/b/tsconfig.json'),
            kind: 'declaration-provider',
          }),
        );
        const build = await execFileAsync(
          process.execPath,
          [
            requireFromTest.resolve('vue-tsc/bin/vue-tsc.js'),
            '-b',
            output,
            '--pretty',
            'false',
          ],
          { cwd: fixture.rootDir },
        );
        expect(build.stderr).toBe('');
        expect(
          existsSync(
            fixture.path(
              'packages/a/dist',
              component ? 'App.vue.d.ts' : 'index.d.ts',
            ),
          ),
        ).toBe(true);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([false, true])(
    'keeps replacement library artifacts outside governance: explicit lib=%s',
    async (explicitLibrary) => {
      const fixture = await createFixture({
        'packages/a/package.json': json({ name: '@example/a', private: true }),
        'packages/b/package.json': json({ name: '@example/b', private: true }),
        'packages/a/tsconfig.json': json({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
            target: 'ES2020',
            types: [],
            libReplacement: true,
            ...(explicitLibrary && { lib: ['ES2022'] }),
          },
          files: ['src/index.ts'],
          liminaOptions: { outputs: { rootDir: './src', target: 'ES2022' } },
        }),
        'packages/a/src/index.ts': 'export const value = 1;',
        'node_modules/@typescript/lib-es2022/package.json': json({
          name: '@typescript/lib-es2022',
          version: '1.0.0',
          types: 'index.d.ts',
        }),
        'node_modules/@typescript/lib-es2022/index.d.ts':
          '/// <reference lib="es2020" />\nimport type { Value } from "../../../packages/b/src/index"; export declare const value: Value;',
        'packages/b/tsconfig.json': json({
          compilerOptions: managedOutputCompilerOptions(),
          files: ['src/index.ts'],
          liminaOptions: { outputs: { rootDir: './src' } },
        }),
        'packages/b/src/index.ts': 'export interface Value { value: number }',
      });
      try {
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        expect(graph.dependencyEdges).toEqual([]);
        const source = fixture.path('packages/a/tsconfig.json');
        const output = graph.configToOutputBuild.get('tsc')!.get(source)!.path;
        const parsed = parseProject(fixture.config, output);
        const program = ts.createProgram({
          rootNames: parsed.fileNames,
          options: parsed.options,
        });
        // A public artifact boundary changes governance, not compiler inputs.
        expect(
          program.getSourceFile(fixture.path('packages/b/src/index.ts')),
        ).toBeDefined();
        expect(program.getRootFileNames()).toEqual([
          fixture.path('packages/a/src/index.ts'),
        ]);
      } finally {
        await fixture.cleanup();
      }
    },
  );
});

function declarationPolicyFiles(
  shared = 'export interface Value { value: string }\n',
): Record<string, string> {
  const options = {
    module: 'ESNext',
    moduleResolution: 'bundler',
    target: 'ES2023',
    types: [],
    strict: true,
  };
  return {
    'packages/a/package.json': json({ name: '@example/a', private: true }),
    'packages/b/package.json': json({ name: '@example/b', private: true }),
    'packages/a/tsconfig.json': json({
      compilerOptions: options,
      files: ['a.ts'],
    }),
    'packages/b/tsconfig.json': json({
      compilerOptions: options,
      files: ['b.d.ts'],
    }),
    'packages/a/a.ts':
      'import type { Value } from "../b/b"; export type Result = Value;\n',
    'packages/b/b.d.ts': shared,
  };
}

describe('declaration configuration governance', () => {
  it('preserves framework checking of local ambient declarations without an external delegation', async () => {
    const fixture = await createFixture({
      'packages/a/tsconfig.json': json({
        compilerOptions: {
          ...managedOutputCompilerOptions(),
          skipLibCheck: true,
        },
        include: ['src/**/*'],
      }),
      'packages/a/src/App.vue':
        '<script setup lang="ts">import css from "./theme.css"; const value = css;</script><template>{{value}}</template>',
      'packages/a/src/theme.css': '.theme {}',
      'packages/a/src/client.d.ts':
        'declare module "*.css" { const value: string; export default value; }',
    });
    fixture.config.scope!.checkers = {
      'vue-tsc': { include: ['packages/a/tsconfig.json'] },
    };
    try {
      const graph = await prepareGeneratedTsconfigGraph(fixture.config);
      expect(graph.dependencyEdges).toEqual([]);
      expect(graph.dependencyAnalysis?.declarationContexts).toEqual([
        expect.objectContaining({
          selection: {
            state: 'local',
            config: fixture.path('packages/a/tsconfig.json'),
          },
        }),
      ]);
      await writeText(
        fixture.path('packages/a/tsconfig.json'),
        json({
          compilerOptions: {
            ...managedOutputCompilerOptions(),
            skipLibCheck: true,
          },
          include: ['src/**/*'],
          liminaOptions: {
            declarationContexts: [
              { file: './src/client.d.ts', config: '../missing/tsconfig.json' },
            ],
          },
        }),
      );
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow('invalid or conflicting declarationContexts choice');
    } finally {
      await fixture.cleanup();
    }
  });
  it.each([false, true])(
    'references a unique pure declaration owner without manufacturing an emit obligation (outputs=%s)',
    async (outputs) => {
      const files = declarationPolicyFiles();
      const aConfig = JSON.parse(files['packages/a/tsconfig.json']!);
      aConfig.compilerOptions.skipLibCheck = true;
      aConfig.files.push('unconsumed.d.ts');
      if (outputs) {
        aConfig.liminaOptions = { outputs: {} };
        const bConfig = JSON.parse(files['packages/b/tsconfig.json']!);
        bConfig.liminaOptions = { outputs: {} };
        files['packages/b/tsconfig.json'] = json(bConfig);
      }
      files['packages/a/tsconfig.json'] = json(aConfig);
      files['packages/a/unconsumed.d.ts'] = 'export interface Unconsumed {}';
      const fixture = await createFixture(files);
      try {
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        expect(
          graph.dependencyEdges.map((edge) => [
            edge.fromConfigPath,
            edge.toConfigPath,
          ]),
        ).toEqual([
          [
            fixture.path('packages/a/tsconfig.json'),
            fixture.path('packages/b/tsconfig.json'),
          ],
        ]);
        expect(graph.dependencyAnalysis?.declarationValidation?.state).toBe(
          'admitted',
        );
        const a = graph.dependencyAnalysis?.declarationContexts?.find(
          (decision) =>
            decision.consumerConfig ===
            fixture.path('packages/a/tsconfig.json'),
        );
        expect(a?.selection).toEqual({
          state: 'selected',
          config: fixture.path('packages/b/tsconfig.json'),
          basis: 'unique-coverage',
        });
        const snapshot = graph.dependencyAnalysis!.nativeEvidence!.find(
          ({ snapshot }) =>
            snapshot.contexts.some((context) => context.id === a!.contextId),
        )!.snapshot;
        expect(
          snapshot.resolutions.some(
            (resolution) =>
              resolution.target?.lexicalPath ===
                fixture.path('packages/b/b.d.ts') &&
              resolution.compilerLoad === 'loaded',
          ),
        ).toBe(false);
        expect(
          snapshot.obligations
            .filter(
              (obligation) => obligation.consumerContextId === a!.contextId,
            )
            .some(
              (obligation) =>
                summarizeCompilationObligation(obligation) !== 'not-required',
            ),
        ).toBe(false);
        await execFileAsync(
          process.execPath,
          [
            requireFromTest.resolve('typescript/bin/tsc'),
            '-b',
            graph.checkerEntries.get('tsc')!,
            '--pretty',
            'false',
          ],
          { cwd: fixture.rootDir },
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('uses the owner paths and keeps the implementation obligation on the owner', async () => {
    const files = declarationPolicyFiles(
      'import type { Value } from "@ctx"; export type { Value };\n',
    );
    files['packages/c/package.json'] = json({
      name: '@example/c',
      private: true,
    });
    files['packages/c/c.ts'] = 'export interface Value { value: string }\n';
    files['packages/c/tsconfig.json'] = json({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'bundler',
        types: [],
      },
      files: ['c.ts'],
    });
    for (const [name, target] of [
      ['a', '../wrong.ts'],
      ['b', '../c/c.ts'],
    ]) {
      const key = `packages/${name}/tsconfig.json`;
      const config = JSON.parse(files[key]!);
      config.compilerOptions.paths = { '@ctx': [target] };
      files[key] = json(config);
    }
    const fixture = await createFixture(files);
    try {
      const graph = await prepareGeneratedTsconfigGraph(fixture.config);
      expect(
        graph.dependencyEdges.map((edge) => [
          edge.fromConfigPath,
          edge.toConfigPath,
        ]),
      ).toEqual([
        [
          fixture.path('packages/a/tsconfig.json'),
          fixture.path('packages/b/tsconfig.json'),
        ],
        [
          fixture.path('packages/b/tsconfig.json'),
          fixture.path('packages/c/tsconfig.json'),
        ],
      ]);
      expect(graph.dependencyAnalysis?.declarationValidation?.state).toBe(
        'admitted',
      );
      await execFileAsync(
        process.execPath,
        [
          requireFromTest.resolve('typescript/bin/tsc'),
          '-b',
          graph.checkerEntries.get('tsc')!,
          '--pretty',
          'false',
        ],
        { cwd: fixture.rootDir },
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('requires an explicit choice for shared declarations and rejects competing final mappings', async () => {
    const files = declarationPolicyFiles();
    files['packages/b2/package.json'] = json({
      name: '@example/b2',
      private: true,
    });
    files['packages/b2/tsconfig.json'] = json({
      compilerOptions: { types: [] },
      files: ['../b/b.d.ts'],
    });
    const fixture = await createFixture(files);
    try {
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow('Choose a declaration context');
      const a = JSON.parse(files['packages/a/tsconfig.json']!);
      a.liminaOptions = {
        declarationContexts: [
          { file: '../b/b.d.ts', config: '../b/tsconfig.json' },
        ],
      };
      await writeText(fixture.path('packages/a/tsconfig.json'), json(a));
      const selected = await prepareGeneratedTsconfigGraph(fixture.config);
      expect(selected.dependencyAnalysis?.declarationValidation?.state).toBe(
        'admitted',
      );
      a.liminaOptions.implicitRefs = [
        { path: '../b2/tsconfig.json', reason: 'Additional required project' },
      ];
      await writeText(fixture.path('packages/a/tsconfig.json'), json(a));
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow('Declaration context mismatch');
      delete a.liminaOptions.implicitRefs;
      await writeText(fixture.path('packages/a/tsconfig.json'), json(a));
      const b2 = JSON.parse(files['packages/b2/tsconfig.json']!);
      b2.liminaOptions = {
        implicitRefs: [
          { path: '../b/tsconfig.json', reason: 'Additional required project' },
        ],
      };
      await writeText(fixture.path('packages/b2/tsconfig.json'), json(b2));
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow('Declaration context mismatch');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('declaration context candidate legality', () => {
  it.each(['configured', 'directive'] as const)(
    'preserves loaded declaration keys and nested requests for %s types',
    async (channel) => {
      const options = managedOutputCompilerOptions();
      const fixture = await createFixture({
        'a/tsconfig.json': json({
          compilerOptions: {
            ...options,
            types: channel === 'configured' ? ['../b'] : [],
          },
          files: ['index.ts'],
        }),
        'a/index.ts': `${channel === 'directive' ? '/// <reference types="../b" />\n' : ''}export const value: SharedValue = { n: 1 };`,
        'b/tsconfig.json': json({
          compilerOptions: { ...options, types: [] },
          files: ['index.d.ts', 'part.d.ts'],
        }),
        'b/index.d.ts':
          'import type { Value } from "./part"; declare global { type SharedValue = Value; }',
        'b/part.d.ts': 'export interface Value { n: number }',
      });
      fixture.config.scope!.checkers = {
        tsc: { include: ['a/tsconfig.json', 'b/tsconfig.json'] },
      };
      try {
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        expect(graph.dependencyEdges).toEqual([
          expect.objectContaining({
            fromConfigPath: fixture.path('a/tsconfig.json'),
            toConfigPath: fixture.path('b/tsconfig.json'),
          }),
        ]);
        const receipt =
          graph.dependencyAnalysis!.declarationValidation!.receipts.find(
            (item) => item.sourceConfig === fixture.path('a/tsconfig.json'),
          )!;
        expect(receipt.mappings).toContainEqual(
          expect.objectContaining({
            file: fixture.path('b/index.d.ts'),
            loaded: true,
          }),
        );
        expect(receipt.requests).toContainEqual(
          expect.objectContaining({
            file: fixture.path('b/index.d.ts'),
            specifier: './part',
            target: fixture.path('b/part.d.ts'),
          }),
        );
        await execFileAsync(
          process.execPath,
          [
            requireFromTest.resolve('typescript/bin/tsc'),
            '-b',
            graph.checkerEntries.get('tsc')!,
            '--pretty',
            'false',
          ],
          { cwd: fixture.rootDir },
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(['skipLibCheck', 'noCheck'] as const)(
    'refuses an owner that disables declaration checking with %s',
    async (option) => {
      const files = declarationPolicyFiles();
      const b = JSON.parse(files['packages/b/tsconfig.json']!);
      b.compilerOptions[option] = true;
      files['packages/b/tsconfig.json'] = json(b);
      const fixture = await createFixture(files);
      try {
        await expect(
          prepareGeneratedTsconfigGraph(fixture.config),
        ).rejects.toThrow('owner must check declarations');
      } finally {
        await fixture.cleanup();
      }
    },
  );
  it.each(['mts', 'cts'] as const)(
    'qualifies a .d.%s declaration input',
    async (extension) => {
      const files = declarationPolicyFiles();
      files[`packages/b/b.d.${extension}`] = files['packages/b/b.d.ts']!;
      delete files['packages/b/b.d.ts'];
      files['packages/a/a.ts'] =
        `import type { Value } from "../b/b.${extension === 'mts' ? 'mjs' : 'cjs'}"; export type Result = Value;`;
      const b = JSON.parse(files['packages/b/tsconfig.json']!);
      b.files = [`b.d.${extension}`];
      files['packages/b/tsconfig.json'] = json(b);
      const fixture = await createFixture(files);
      try {
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        expect(graph.dependencyAnalysis?.declarationValidation?.state).toBe(
          'admitted',
        );
        expect(graph.dependencyEdges).toHaveLength(1);
      } finally {
        await fixture.cleanup();
      }
    },
  );
  it('rejects policy reference cycles before materialization', async () => {
    const files = declarationPolicyFiles(
      'import "../a/local"; export interface Value {}',
    );
    const a = JSON.parse(files['packages/a/tsconfig.json']!);
    a.files.push('local.d.ts');
    files['packages/a/tsconfig.json'] = json(a);
    files['packages/a/local.d.ts'] = 'export interface Local {}';
    const fixture = await createFixture(files);
    try {
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow('reference cycle');
      expect(existsSync(fixture.path('.limina/tsconfig'))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('declaration consumption responsibilities', () => {
  it.each(['skipLibCheck', 'noCheck'] as const)(
    'keeps local %s checking policy until the config is selected externally',
    async (option) => {
      const files = declarationPolicyFiles();
      const a = JSON.parse(files['packages/a/tsconfig.json']!);
      a.compilerOptions[option] = true;
      a.files.push('local.d.ts');
      files['packages/a/tsconfig.json'] = json(a);
      files['packages/a/local.d.ts'] = files['packages/b/b.d.ts']!;
      files['packages/a/a.ts'] =
        'import type { Value } from "./local"; export type Result = Value;';
      const fixture = await createFixture(files);
      try {
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        expect(graph.dependencyEdges).toEqual([]);
        expect(graph.dependencyAnalysis?.declarationContexts).toContainEqual(
          expect.objectContaining({
            selection: {
              state: 'local',
              config: fixture.path('packages/a/tsconfig.json'),
            },
          }),
        );
        await writeText(
          fixture.path('packages/b/b.d.ts'),
          'export type { Value } from "../a/local";',
        );
        await expect(
          prepareGeneratedTsconfigGraph(fixture.config),
        ).rejects.toThrow('owner must check declarations');
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([false, true])(
    'compares upstream private declaration requests only when loaded (consumed=%s)',
    async (consumed) => {
      const files = declarationPolicyFiles();
      const b = JSON.parse(files['packages/b/tsconfig.json']!);
      b.files = ['b.ts', 'private.d.ts', 'part.d.ts'];
      files['packages/b/tsconfig.json'] = json(b);
      delete files['packages/b/b.d.ts'];
      files['packages/b/b.ts'] =
        'import type { Private } from "./private"; const hidden: Private = {value:"x"}; export const value = 1;';
      files['packages/b/private.d.ts'] =
        'import type { Part } from "./part"; export type Private = Part;';
      files['packages/b/part.d.ts'] = 'export interface Part { value: string }';
      files['packages/a/a.ts'] =
        `import { value } from "../b/b"; export const result = value;${
          consumed
            ? 'import type { Private } from "../b/private"; export type Result = Private;'
            : ''
        }`;
      const fixture = await createFixture(files);
      try {
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        const generated = graph.sourceToDts
          .get('tsc')!
          .get(fixture.path('packages/a/tsconfig.json'))!;
        const receipt =
          graph.dependencyAnalysis!.declarationValidation!.receipts.find(
            (candidate) => candidate.generatedConfig === generated,
          );
        if (consumed)
          expect(receipt?.mappings).toContainEqual(
            expect.objectContaining({
              file: fixture.path('packages/b/private.d.ts'),
              loaded: true,
            }),
          );
        expect(
          receipt?.requests.some(
            (request) =>
              request.file === fixture.path('packages/b/private.d.ts'),
          ) ?? false,
        ).toBe(consumed);
        expect(
          new Set(graph.dependencyEdges.map((edge) => edge.toConfigPath)),
        ).toEqual(new Set([fixture.path('packages/b/tsconfig.json')]));
        await execFileAsync(
          process.execPath,
          [
            requireFromTest.resolve('typescript/bin/tsc'),
            '-b',
            graph.checkerEntries.get('tsc')!,
            '--pretty',
            'false',
          ],
          { cwd: fixture.rootDir },
        );
        const parsed = ts.getParsedCommandLineOfConfigFile(
          generated,
          {},
          {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
              throw new Error(String(diagnostic.messageText));
            },
          },
        )!;
        const program = ts.createProgram({
          rootNames: parsed.fileNames,
          options: parsed.options,
          projectReferences: parsed.projectReferences,
        });
        expect(
          program.getSourceFile(fixture.path('packages/b/private.d.ts')) !==
            undefined,
        ).toBe(consumed);
        expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(['ambient', 'unresolved'] as const)(
    'preserves completed %s request evidence without inventing a redirect',
    async (state) => {
      const files = declarationPolicyFiles(
        `${
          state === 'ambient'
            ? 'declare module "ctx-base" { export interface Base { value: string } }\n'
            : ''
        }declare module "ctx-public" { import type { Base } from "ctx-base"; export type Public = Base; }`,
      );
      files['packages/a/a.ts'] =
        'import "../b/b"; import type { Public } from "ctx-public"; export type Result = Public;';
      const fixture = await createFixture(files);
      try {
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        const generated = graph.sourceToDts
          .get('tsc')!
          .get(fixture.path('packages/a/tsconfig.json'))!;
        const receipt =
          graph.dependencyAnalysis!.declarationValidation!.receipts.find(
            (candidate) => candidate.generatedConfig === generated,
          )!;
        const request = receipt.requests.find(
          (item) => item.specifier === 'ctx-base',
        )!;
        expect(request).toMatchObject({ resolutionState: state, target: null });
        expect(request.redirects).toEqual(
          state === 'ambient'
            ? []
            : [
                graph.sourceToDts
                  .get('tsc')!
                  .get(fixture.path('packages/b/tsconfig.json'))!,
              ],
        );
        const parsed = ts.getParsedCommandLineOfConfigFile(
          generated,
          {},
          {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
              throw new Error(String(diagnostic.messageText));
            },
          },
        )!;
        const program = ts.createProgram({
          rootNames: parsed.fileNames,
          options: parsed.options,
          projectReferences: parsed.projectReferences,
        });
        expect(
          ts
            .getPreEmitDiagnostics(program)
            .some((diagnostic) => diagnostic.code === 2307),
        ).toBe(state === 'unresolved');
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(['none', 'root', 'types', 'types-with-owner-import'] as const)(
    'retains only independent declaration inputs under noResolve (%s)',
    async (source) => {
      const files = declarationPolicyFiles();
      const a = JSON.parse(files['packages/a/tsconfig.json']!);
      a.compilerOptions.noResolve = true;
      a.compilerOptions.noUncheckedSideEffectImports = false;
      if (source === 'root') a.files.push('../b/b.d.ts');
      if (source.startsWith('types')) a.compilerOptions.types = ['../b/b'];
      files['packages/a/tsconfig.json'] = json(a);
      files['packages/a/a.ts'] = 'import "../b/b"; export const value = 1;';
      if (source === 'types-with-owner-import') {
        const b = JSON.parse(files['packages/b/tsconfig.json']!);
        b.files.push('part.d.ts');
        files['packages/b/tsconfig.json'] = json(b);
        files['packages/b/b.d.ts'] = 'export type { Value } from "./part";';
        files['packages/b/part.d.ts'] =
          'export interface Value { value: string }';
      }
      const fixture = await createFixture(files);
      try {
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        expect(graph.dependencyEdges).toHaveLength(
          source.startsWith('types') ? 1 : 0,
        );
        const decisions = graph.dependencyAnalysis!.declarationContexts ?? [];
        const consumer = decisions.filter(
          (decision) =>
            decision.consumerConfig ===
            fixture.path('packages/a/tsconfig.json'),
        );
        if (source === 'none') expect(consumer).toEqual([]);
        else expect(consumer).toHaveLength(1);
        if (source === 'root')
          expect(consumer[0]!.selection.state).toBe('local');
        if (source.startsWith('types')) {
          const snapshot = graph.dependencyAnalysis!.nativeEvidence!.find(
            ({ snapshot }) =>
              snapshot.contexts.some(
                (context) => context.id === consumer[0]!.contextId,
              ),
          )!.snapshot;
          expect(
            consumer[0]!.requestIds.map(
              (id) =>
                snapshot.requests.find((request) => request.id === id)!.channel,
            ),
          ).toEqual(['type-directive']);
          const receipt =
            graph.dependencyAnalysis!.declarationValidation!.receipts.find(
              (candidate) =>
                candidate.sourceConfig ===
                fixture.path('packages/a/tsconfig.json'),
            )!;
          expect(receipt.mappings).toContainEqual(
            expect.objectContaining({
              file: fixture.path('packages/b/b.d.ts'),
              loaded: true,
            }),
          );
          if (source === 'types-with-owner-import')
            expect(receipt.requests).toContainEqual(
              expect.objectContaining({
                specifier: './part',
                resolutionState: 'resolved',
              }),
            );
        }
      } finally {
        await fixture.cleanup();
      }
    },
  );
});

describe('declaration candidate evidence failures', () => {
  it.each([
    ['not-loaded', 'Selected declaration was not loaded'],
    ['target', 'Declaration request context differs'],
    ['redirect', 'did not use the selected reference'],
    ['unavailable', 'Unavailable declaration request'],
    ['context', 'Unbound declaration request'],
  ] as const)(
    'refuses %s drift for a declaration actually consumed by A',
    async (kind, diagnostic) => {
      const files = declarationPolicyFiles(
        'export type { Value } from "./part";',
      );
      const b = JSON.parse(files['packages/b/tsconfig.json']!);
      b.files.push('part.d.ts');
      files['packages/b/tsconfig.json'] = json(b);
      files['packages/b/part.d.ts'] =
        'export interface Value { value: string }';
      const fixture = await createFixture(files);
      const original = nativeFactory.createNativeSemanticContext;
      const create = vi
        .spyOn(nativeFactory, 'createNativeSemanticContext')
        .mockImplementation((project, cache, metrics) => {
          const context = original(project, cache, metrics);
          if (
            project.declarationContextValidation?.sourceConfig ===
            fixture.path('packages/a/tsconfig.json')
          ) {
            if (kind === 'not-loaded') {
              const sources = context.program.getSourceFiles();
              Object.defineProperty(context.program, 'getSourceFiles', {
                value: () =>
                  sources.filter(
                    (source) =>
                      normalizeAbsolutePath(source.fileName) !==
                      fixture.path('packages/b/b.d.ts'),
                  ),
              });
              return context;
            }
            const snapshot = context.nativeEvidence!;
            const request = snapshot.requests.find(
              (item) => item.specifier === './part',
            )!;
            Object.defineProperty(context, 'nativeEvidence', {
              value: {
                ...snapshot,
                requests:
                  kind === 'context'
                    ? snapshot.requests.map((item) =>
                        item.id === request.id
                          ? { ...item, consumerContextId: 'unrelated-context' }
                          : item,
                      )
                    : snapshot.requests,
                resolutions: snapshot.resolutions.map((resolution) => {
                  if (resolution.requestId !== request.id) return resolution;
                  if (kind === 'unavailable')
                    return { ...resolution, state: 'unavailable' };
                  if (kind === 'redirect')
                    return { ...resolution, rawRedirectEvidenceIds: [] };
                  if (kind === 'target')
                    return {
                      ...resolution,
                      target: {
                        ...resolution.target!,
                        lexicalPath: fixture.path('packages/b/wrong.d.ts'),
                      },
                    };
                  return resolution;
                }),
              },
            });
          }
          return context;
        });
      try {
        await expect(
          prepareGeneratedTsconfigGraph(fixture.config),
        ).rejects.toThrow(diagnostic);
      } finally {
        create.mockRestore();
        await fixture.cleanup();
      }
    },
  );
});

it('retains competing-reference protection for a local declaration root with skipLibCheck', async () => {
  const files = declarationPolicyFiles();
  const a = JSON.parse(files['packages/a/tsconfig.json']!);
  a.files.push('local.d.ts');
  a.compilerOptions.skipLibCheck = true;
  a.liminaOptions = {
    implicitRefs: [
      { path: '../b/tsconfig.json', reason: 'Required build ordering' },
    ],
  };
  const b = JSON.parse(files['packages/b/tsconfig.json']!);
  b.files = ['../a/local.d.ts'];
  files['packages/a/tsconfig.json'] = json(a);
  files['packages/b/tsconfig.json'] = json(b);
  files['packages/a/local.d.ts'] = files['packages/b/b.d.ts']!;
  files['packages/a/a.ts'] =
    'import type { Value } from "./local"; export type Result = Value;';
  const fixture = await createFixture(files);
  try {
    await expect(prepareGeneratedTsconfigGraph(fixture.config)).rejects.toThrow(
      'Declaration context mismatch',
    );
  } finally {
    await fixture.cleanup();
  }
});

describe('compiler requests and final reference admission', () => {
  it.each([
    { name: 'SFC-only JSX request', jsx: true, references: 1 },
    { name: 'SFC-only helper request', jsx: false, references: 1 },
    {
      name: 'SFC-only JSX noResolve',
      jsx: true,
      noResolve: true,
      references: 0,
    },
    {
      name: 'SFC-only helper noResolve',
      jsx: false,
      noResolve: true,
      references: 0,
    },
  ])('preserves $name', async (scenario) => {
    const compilerOptions = {
      composite: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      types: [],
    };
    const fixture = await createFixture({
      'packages/a/tsconfig.json': json({
        compilerOptions: {
          ...compilerOptions,
          noResolve: scenario.noResolve,
          ...(scenario.jsx
            ? { jsx: 'react-jsx', jsxImportSource: '../b' }
            : { importHelpers: true, paths: { tslib: ['../b/helper.ts'] } }),
        },
        files: ['App.vue'],
      }),
      'packages/a/App.vue': scenario.jsx
        ? '<script lang="tsx">export const view = <div />;</script>'
        : '<script lang="ts">export const value = 1;</script>',
      'packages/b/tsconfig.json': json({
        compilerOptions,
        files: [scenario.jsx ? 'jsx-runtime.ts' : 'helper.ts'],
      }),
      [`packages/b/${scenario.jsx ? 'jsx-runtime.ts' : 'helper.ts'}`]:
        scenario.jsx
          ? 'export namespace JSX { export interface Element {} export interface IntrinsicElements { div: {} } } export const jsx = () => ({}); export const jsxs = jsx;'
          : 'export const helper = 1;',
    });
    fixture.config.scope!.checkers = {
      'vue-tsc': { include: ['packages/*/tsconfig.json'] },
    };
    try {
      const graph = await prepareGeneratedTsconfigGraph(fixture.config);
      const generated = graph.sourceToDts
        .get('vue-tsc')!
        .get(fixture.path('packages/a/tsconfig.json'))!;
      expect(
        JSON.parse(await readFile(generated, 'utf8')).references,
      ).toHaveLength(scenario.references);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    { language: 'js', allowJs: false, references: 0 },
    { language: 'js', allowJs: true, references: 1 },
    { language: 'ts', allowJs: false, references: 1 },
  ])(
    'qualifies $language service input with allowJs=$allowJs',
    async (scenario) => {
      const compilerOptions = {
        composite: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: [],
        noImplicitAny: false,
      };
      const fixture = await createFixture({
        'packages/a/tsconfig.json': json({
          compilerOptions: { ...compilerOptions, allowJs: scenario.allowJs },
          files: ['a.ts'],
        }),
        'packages/a/a.ts':
          'import B from "../b/B.vue"; export const component = B;',
        'packages/b/tsconfig.json': json({
          compilerOptions: {
            ...compilerOptions,
            allowJs: scenario.language === 'js',
          },
          files: ['B.vue'],
        }),
        'packages/b/B.vue': `<script lang="${scenario.language}">export const b = 1;</script>`,
      });
      fixture.config.scope!.checkers = {
        'vue-tsc': { include: ['packages/*/tsconfig.json'] },
      };
      try {
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        const generated = graph.sourceToDts
          .get('vue-tsc')!
          .get(fixture.path('packages/a/tsconfig.json'))!;
        expect(
          JSON.parse(await readFile(generated, 'utf8')).references,
        ).toHaveLength(scenario.references);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([false, true])(
    'does not turn an augmentation into declaration consumption (skipLibCheck=%s)',
    async (skipLibraryCheck) => {
      const compilerOptions = {
        composite: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: [],
        skipLibCheck: skipLibraryCheck,
      };
      const fixture = await createFixture({
        'packages/a/tsconfig.json': json({
          compilerOptions,
          files: ['a.ts', 'env.d.ts'],
        }),
        'packages/a/a.ts': 'export interface A { value?: number }',
        'packages/a/env.d.ts':
          'export {}; declare module "../b/b" { interface Added {} }',
        'packages/b/tsconfig.json': json({
          compilerOptions: { ...compilerOptions, skipLibCheck: false },
          files: ['b.d.ts'],
        }),
        'packages/b/b.d.ts': 'export interface B {}',
      });
      try {
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        const generated = graph.sourceToDts
          .get('tsc')!
          .get(fixture.path('packages/a/tsconfig.json'))!;
        expect(
          JSON.parse(await readFile(generated, 'utf8')).references,
        ).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([
    {
      name: 'TS runtime require',
      extension: 'ts',
      source: 'require("../b/b");',
      references: 0,
    },
    {
      name: 'TS dynamic import does not qualify require',
      extension: 'ts',
      source: 'require("../b/b"); void import("./local");',
      references: 0,
    },
    {
      name: 'JS require',
      extension: 'js',
      source: 'require("../b/b");',
      references: 1,
    },
    {
      name: 'JS shadowed require',
      extension: 'js',
      source:
        '/** @param {(id: string) => unknown} require */\nfunction f(require) { require("../b/b"); }',
      references: 1,
    },
    {
      name: 'import equals',
      extension: 'ts',
      source: 'import b = require("../b/b"); void b;',
      references: 1,
      module: 'Preserve',
    },
    {
      name: 'path directive',
      extension: 'ts',
      source: '/// <reference path="../b/b.ts" />',
      references: 1,
    },
    {
      name: 'noResolve path directive',
      extension: 'ts',
      source: '/// <reference path="../b/b.ts" />',
      references: 0,
      noResolve: true,
    },
    {
      name: 'TS SFC require',
      extension: 'vue',
      language: 'ts',
      source: 'require("../b/b.vue");',
      references: 0,
    },
    {
      name: 'JS SFC require',
      extension: 'vue',
      language: 'js',
      source: 'require("../b/b.vue");',
      references: 1,
    },
    {
      name: 'SFC import',
      extension: 'vue',
      language: 'ts',
      source: 'import B from "../b/b.vue";',
      references: 1,
    },
    {
      name: 'implicit JSX runtime',
      extension: 'tsx',
      source: 'export const view = <div />;',
      jsx: 'react-jsx',
      references: 1,
    },
    {
      name: 'JSON resource outside compiler roots',
      extension: 'ts',
      source: 'import value from "../../metadata.json"; void value;',
      references: 0,
      resolveJsonModule: true,
    },
    {
      name: 'SFC JSON resource outside compiler roots',
      extension: 'vue',
      language: 'ts',
      source: 'import value from "../../metadata.json"; void value;',
      references: 0,
      resolveJsonModule: true,
    },
    {
      name: 'static import',
      extension: 'ts',
      source: 'import "../b/b";',
      references: 1,
    },
    {
      name: 'noResolve input absence',
      extension: 'ts',
      source: 'import "../b/b";',
      references: 0,
      noResolve: true,
    },
  ])('uses Vue compiler obligations for $name', async (scenario) => {
    const files: Record<string, string> = { 'metadata.json': '{"value":1}' };
    for (const name of ['a', 'b']) {
      files[`packages/${name}/tsconfig.json`] = json({
        compilerOptions: {
          composite: true,
          module: scenario.module ?? 'ESNext',
          moduleResolution: 'Bundler',
          target: 'ES2022',
          jsx: scenario.jsx,
          jsxImportSource: scenario.jsx === undefined ? undefined : '../b',
          types: [],
          allowJs: scenario.extension === 'js' || scenario.language === 'js',
          noResolve: scenario.noResolve,
          resolveJsonModule: scenario.resolveJsonModule,
        },
        include: ['*'],
      });
      const code = `${name === 'a' ? scenario.source : ''}\nexport const ${name} = 1;`;
      files[`packages/${name}/${name}.${scenario.extension}`] =
        scenario.extension === 'vue'
          ? `<script lang="${scenario.language}">${code}</script><template><div /></template>`
          : code;
      files[`packages/${name}/env.d.ts`] =
        'declare function require(id: string): unknown;';
      files[`packages/${name}/local.ts`] = 'export const local = 1;';
    }
    if (scenario.jsx !== undefined)
      files['packages/b/jsx-runtime.ts'] =
        'export namespace JSX { export interface IntrinsicElements { div: {} } } export const jsx = () => null; export const jsxs = jsx;';
    const fixture = await createFixture(files);
    fixture.config.scope!.checkers = {
      'vue-tsc': { include: ['packages/*/tsconfig.json'] },
    };
    try {
      const graph = await prepareGeneratedTsconfigGraph(fixture.config);
      expect(
        new Set(
          graph.dependencyEdges.map((edge) =>
            JSON.stringify([edge.fromConfigPath, edge.toConfigPath]),
          ),
        ).size,
      ).toBe(scenario.references);
      const generated = graph.sourceToDts
        .get('vue-tsc')!
        .get(fixture.path('packages/a/tsconfig.json'))!;
      expect(
        JSON.parse(await readFile(generated, 'utf8')).references,
      ).toHaveLength(scenario.references);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['static', 'implicit'] as const)(
    'rejects a final %s reference cycle before materialization',
    async (kind) => {
      const files: Record<string, string> = {};
      for (const name of ['a', 'b']) {
        const other = name === 'a' ? 'b' : 'a';
        files[`packages/${name}/tsconfig.json`] = json({
          compilerOptions: {
            composite: true,
            module: 'ESNext',
            moduleResolution: 'Bundler',
            target: 'ES2022',
            types: [],
          },
          include: ['*.ts'],
          ...(kind === 'implicit' && {
            liminaOptions: {
              implicitRefs: [
                {
                  path: `../${other}/tsconfig.json`,
                  reason: 'Fixture explicit relationship',
                },
              ],
            },
          }),
        });
        files[`packages/${name}/${name}.ts`] =
          `${kind === 'static' ? `import "../${other}/${other}";` : ''} export const ${name} = 1;`;
      }
      const fixture = await createFixture(files);
      try {
        await expect(
          prepareGeneratedTsconfigGraph(fixture.config),
        ).rejects.toMatchObject({
          issues: expect.arrayContaining([
            expect.objectContaining({
              checkerName: 'tsc',
              code: 'LIMINA_GRAPH_REFERENCE_CYCLE',
              filePath:
                '.limina/tsconfig/checkers/tsc/projects/packages/a/tsconfig.dts.json',
              reason: 'TypeScript project references must be acyclic.',
            }),
          ]),
        });
        expect(existsSync(fixture.path('.limina/tsconfig'))).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
  );
});

describe('checker-neutral declaration governance', () => {
  it.each([false, true])(
    'compares nested declaration requests across explicitly mapped boundaries (differs=%s)',
    async (differs) => {
      const compilerOptions = {
        composite: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: [],
      };
      const aConfig = {
        compilerOptions,
        files: ['App.vue'],
        liminaOptions: {
          declarationContexts: [
            { file: '../shared/api.d.ts', config: '../d/tsconfig.json' },
          ],
        },
      };
      const fixture = await createFixture({
        'packages/a/tsconfig.json': json({
          ...aConfig,
          references: [{ path: '../b' }, { path: '../d' }],
        }),
        'packages/a/App.vue':
          '<script setup lang="ts">import type { Nested } from "../b/entry"; import type { Api } from "../shared/api"; let nested: Nested; let api: Api;</script>',
        'packages/b/tsconfig.json': json({
          compilerOptions: {
            ...compilerOptions,
            paths: { dep: ['../values/left.d.ts'] },
          },
          files: ['entry.d.ts', '../shared/api.d.ts'],
        }),
        'packages/d/tsconfig.json': json({
          compilerOptions: {
            ...compilerOptions,
            paths: { dep: [`../values/${differs ? 'right' : 'left'}.d.ts`] },
          },
          files: ['../shared/api.d.ts'],
        }),
        'packages/b/entry.d.ts':
          'export type { Api as Nested } from "../shared/api";',
        'packages/shared/api.d.ts':
          'import type { Model } from "dep"; export type Api = Model;',
        'packages/values/left.d.ts': 'export interface Model { value: number }',
        'packages/values/right.d.ts':
          'export interface Model { value: number }',
      });
      fixture.config.scope!.checkers = {
        'vue-tsc': { include: ['packages/*/tsconfig.json'] },
      };
      try {
        const a = fixture.path('packages/a/tsconfig.json');
        const bin = requireFromTest.resolve('vue-tsc/bin/vue-tsc.js');
        // Both environments typecheck: a successful build alone does not prove
        // that B's delegated declaration requests retained their context.
        await execFileAsync(
          process.execPath,
          [bin, '-b', a, '--pretty', 'false'],
          {
            cwd: fixture.rootDir,
          },
        );
        await writeText(a, json(aConfig));
        const preparation = prepareGeneratedTsconfigGraph(fixture.config);
        if (differs) {
          await expect(preparation).rejects.toThrow(
            'Declaration request context differs from its selected owner',
          );
          return;
        }
        const graph = await preparation;
        expect(graph.dependencyAnalysis!.declarationValidation!.state).toBe(
          'admitted',
        );
        const receipt =
          graph.dependencyAnalysis!.declarationValidation!.receipts.find(
            (candidate) => candidate.sourceConfig === a,
          )!;
        expect(receipt.mappings).toContainEqual(
          expect.objectContaining({
            file: fixture.path('packages/shared/api.d.ts'),
            sourceConfig: fixture.path('packages/d/tsconfig.json'),
            loaded: true,
          }),
        );
        expect(receipt.requests).toContainEqual(
          expect.objectContaining({
            file: fixture.path('packages/shared/api.d.ts'),
            specifier: 'dep',
            target: fixture.path('packages/values/left.d.ts'),
          }),
        );
        await execFileAsync(
          process.execPath,
          [
            bin,
            '-b',
            graph.sourceToDts.get('vue-tsc')!.get(a)!,
            '--pretty',
            'false',
          ],
          {
            cwd: fixture.rootDir,
          },
        );
      } finally {
        await fixture.cleanup();
      }
    },
    60_000,
  );
  it.each([
    'unused',
    'private-consumption',
    'local-root',
    'selected',
    'conflicting',
  ] as const)(
    'keeps independent shared declaration inputs scoped to their own context (%s)',
    async (variant) => {
      const compilerOptions = {
        composite: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: [],
      };
      const isSelected = variant === 'selected' || variant === 'conflicting';
      const fixture = await createFixture({
        'packages/a/tsconfig.json': json({
          compilerOptions,
          files:
            variant === 'local-root' ? ['App.vue', 'local.d.ts'] : ['App.vue'],
          ...(isSelected && {
            liminaOptions: {
              declarationContexts: [
                {
                  file: '../shared/api.d.ts',
                  config:
                    variant === 'selected'
                      ? '../d/tsconfig.json'
                      : '../b/tsconfig.json',
                },
              ],
            },
          }),
        }),
        'packages/a/App.vue': `<script setup lang="ts">import { b } from "../b/model"; import { d } from "../d/model"; ${isSelected ? 'import type { Api } from "../shared/api"; let api: Api;' : ''} let value = b + d;</script>`,
        'packages/a/local.d.ts': 'export interface Local {}',
        'packages/b/tsconfig.json': json({
          compilerOptions,
          files: ['model.ts', '../shared/api.d.ts'],
        }),
        'packages/d/tsconfig.json': json({
          compilerOptions,
          files: ['model.ts', '../shared/api.d.ts'],
        }),
        'packages/b/model.ts': `${variant === 'private-consumption' ? 'import type { Api } from "../shared/api";' : ''} export const b = 1;`,
        'packages/d/model.ts': `${variant === 'private-consumption' ? 'import type { Api } from "../shared/api";' : ''} export const d = 2;`,
        'packages/shared/api.d.ts': 'export interface Api { value: number }',
      });
      fixture.config.scope!.checkers = {
        'vue-tsc': { include: ['packages/*/tsconfig.json'] },
      };
      try {
        const preparation = prepareGeneratedTsconfigGraph(fixture.config);
        if (variant === 'conflicting') {
          await expect(preparation).rejects.toThrow(
            'Declaration context mismatch',
          );
          return;
        }
        const graph = await preparation;
        const a = fixture.path('packages/a/tsconfig.json');
        expect(
          [
            ...new Set(
              graph.dependencyEdges
                .filter((edge) => edge.fromConfigPath === a)
                .map((edge) => edge.toConfigPath),
            ),
          ].sort(compareCodeUnits),
        ).toEqual([
          fixture.path('packages/b/tsconfig.json'),
          fixture.path('packages/d/tsconfig.json'),
        ]);
        expect(graph.dependencyAnalysis!.declarationValidation!.state).toBe(
          'admitted',
        );
        const choices = graph.dependencyAnalysis!.declarationContexts!.filter(
          (decision) => decision.consumerConfig === a,
        );
        expect(
          choices.filter((decision) => decision.kind === 'consumption'),
        ).toHaveLength(isSelected ? 1 : 0);
        if (isSelected) {
          const receipt =
            graph.dependencyAnalysis!.declarationValidation!.receipts.find(
              (entry) => entry.sourceConfig === a,
            )!;
          expect(receipt.mappings).toContainEqual(
            expect.objectContaining({
              file: fixture.path('packages/shared/api.d.ts'),
              sourceConfig: fixture.path('packages/d/tsconfig.json'),
              loaded: true,
            }),
          );
        }
        await execFileAsync(
          process.execPath,
          [
            requireFromTest.resolve('vue-tsc/bin/vue-tsc.js'),
            '-b',
            graph.sourceToDts.get('vue-tsc')!.get(a)!,
            '--pretty',
            'false',
          ],
          { cwd: fixture.rootDir },
        );
      } finally {
        await fixture.cleanup();
      }
    },
    60_000,
  );
  it.each([
    { kind: 'path', noResolve: false },
    { kind: 'path', noResolve: true },
    { kind: 'types', noResolve: false },
    { kind: 'types', noResolve: true },
  ])(
    'distinguishes suppressed declaration $kind directives with noResolve=$noResolve',
    async ({ kind, noResolve }) => {
      const targetName = kind === 'path' ? 'model.ts' : 'model.d.ts';
      const specifier = `../c/${targetName}`;
      const channel = kind === 'path' ? 'path-directive' : 'type-directive';
      const compilerOptions = {
        composite: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: [],
      };
      const fixture = await createFixture({
        'packages/b/tsconfig.json': json({
          compilerOptions: { ...compilerOptions, noResolve },
          files: ['api.d.ts'],
        }),
        'packages/b/api.d.ts': `/// <reference ${kind}="${specifier}"/>\nexport interface Api {}`,
        'packages/c/tsconfig.json': json({
          compilerOptions,
          files: [targetName],
        }),
        [`packages/c/${targetName}`]: 'export interface Model {}',
      });
      fixture.config.scope!.checkers = {
        'vue-tsc': { include: ['packages/*/tsconfig.json'] },
      };
      const manager = new VueSemanticContextManager();
      try {
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        const source = fixture.path('packages/b/tsconfig.json');
        const context = manager.acquire(
          graph.governedSources.get('vue-tsc')!.get(source)!.context
            .vueSemanticIdentity!,
        );
        const candidate =
          graph.dependencyAnalysis!.declarationValidation!.receipts.find(
            (receipt) => receipt.sourceConfig === source,
          )!;
        for (const requests of [
          collectVueRequestInventory(context).requests,
          candidate.requests,
        ])
          expect(
            requests.filter((request) => request.channel === channel),
          ).toEqual([
            expect.objectContaining({
              specifier,
              resolutionState: noResolve ? 'suppressed' : 'resolved',
              target: noResolve
                ? null
                : fixture.path(`packages/c/${targetName}`),
            }),
          ]);
        const bin = requireFromTest.resolve('vue-tsc/bin/vue-tsc.js');
        const listed = await execFileAsync(
          process.execPath,
          [bin, '-p', source, '--listFilesOnly', '--pretty', 'false'],
          { cwd: fixture.rootDir },
        );
        expect(
          listed.stdout
            .trim()
            .split(/\r?\n/)
            .map(toPortablePath)
            .includes(fixture.path(`packages/c/${targetName}`)),
        ).toBe(!noResolve);
        const target = graph.sourceToDts.get('vue-tsc')!.get(source)!;
        await execFileAsync(
          process.execPath,
          [bin, '-b', target, '--pretty', 'false'],
          { cwd: fixture.rootDir },
        );
      } finally {
        manager.dispose();
        await fixture.cleanup();
      }
    },
    60_000,
  );
  it('keeps custom-plugin declaration delegation unavailable after a successful Vue checker control', async () => {
    const compilerOptions = {
      module: 'ESNext',
      moduleResolution: 'Bundler',
      types: [],
    };
    const fixture = await createFixture({
      'packages/a/tsconfig.json': json({ compilerOptions, files: ['App.vue'] }),
      'packages/a/App.vue':
        '<script setup lang="ts">import type { Model } from "../b/api"; let value: Model;</script>',
      'packages/b/tsconfig.json': json({
        compilerOptions,
        files: ['api.d.ts'],
        vueCompilerOptions: { plugins: ['./plugin.cjs'] },
      }),
      'packages/b/plugin.cjs': 'module.exports = () => ({version: 2.2});',
      'packages/b/api.d.ts': 'export interface Model { value: number }',
    });
    fixture.config.scope!.checkers = {
      'vue-tsc': { include: ['packages/*/tsconfig.json'] },
    };
    try {
      await execFileAsync(
        process.execPath,
        [
          requireFromTest.resolve('vue-tsc/bin/vue-tsc.js'),
          '-p',
          fixture.path('packages/b/tsconfig.json'),
          '--noEmit',
          '--pretty',
          'false',
        ],
        { cwd: fixture.rootDir },
      );
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow('custom plugins lacks input provenance qualification');
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);
  it.each([
    'typescript',
    'vue',
    'retained',
    'path',
    'automatic',
    'environment',
  ])(
    'delegates %s declaration requests with an actual Vue build',
    async (kind) => {
      const isButton = kind === 'vue';
      const compilerOptions = {
        composite: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: [],
        skipLibCheck: false,
      };
      const fixture = await createFixture({
        'packages/a/tsconfig.json': json({
          compilerOptions:
            kind === 'automatic'
              ? { ...compilerOptions, types: ['../b/api'] }
              : compilerOptions,
          files: ['App.vue'],
        }),
        'packages/a/App.vue':
          kind === 'automatic'
            ? '<script setup lang="ts">let value: AuditModel;</script>'
            : '<script setup lang="ts">import type { Model } from "../b/api"; let value: Model;</script>',
        'packages/b/tsconfig.json': json({
          compilerOptions,
          files: isButton ? ['api.d.ts', 'Button.vue'] : ['api.d.ts'],
        }),
        'packages/b/api.d.ts': isButton
          ? 'import Button from "./Button.vue"; export type Model = typeof Button;'
          : kind === 'retained'
            ? 'export type { Model } from "./internal";'
            : kind === 'path'
              ? '/// <reference path="../c/model.ts"/>\nexport interface Model {}'
              : kind === 'automatic'
                ? 'import type { Model } from "../c/model"; declare global { type AuditModel = Model; }'
                : kind === 'environment'
                  ? '/// <reference types="fixture-type" />\nexport type { Model } from "../c/model";'
                  : 'export type { Model } from "../c/model";',
        'node_modules/@types/fixture-type/package.json': json({
          name: '@types/fixture-type',
          version: '1.0.0',
          types: 'index.d.ts',
          type: 'commonjs',
        }),
        'node_modules/@types/fixture-type/index.d.ts':
          'declare module "fixture-own" { export const value: number; } declare module "node:fixture-own" { export * from "fixture-own"; }',
        'packages/b/internal.d.ts': 'export type { Model } from "../c/model";',
        'packages/b/Button.vue':
          '<script setup lang="ts">defineProps<{label: string}>();</script>',
        'packages/c/tsconfig.json': json({
          compilerOptions,
          files: ['model.ts'],
        }),
        'packages/c/model.ts': 'export interface Model { value: number }',
      });
      fixture.config.scope!.checkers = {
        'vue-tsc': { include: ['packages/*/tsconfig.json'] },
      };
      try {
        const graph = await prepareGeneratedTsconfigGraph(fixture.config);
        const a = fixture.path('packages/a/tsconfig.json');
        const b = fixture.path('packages/b/tsconfig.json');
        const c = fixture.path('packages/c/tsconfig.json');
        expect(
          graph.dependencyEdges
            .filter((edge) => edge.fromConfigPath === a)
            .map((edge) => edge.toConfigPath),
        ).toEqual([b]);
        expect(
          graph.dependencyEdges.some(
            (edge) => edge.fromConfigPath === b && edge.toConfigPath === c,
          ),
        ).toBe(!isButton);
        const validation = graph.dependencyAnalysis!.declarationValidation!;
        expect(validation.state).toBe('admitted');
        expect(
          validation.receipts.every(
            (receipt) =>
              receipt.authority.adapter === 'vue-cli-declaration-candidate-v1',
          ),
        ).toBe(true);
        const target = graph.sourceToDts.get('vue-tsc')!.get(a)!;
        const built = await execFileAsync(
          process.execPath,
          [
            requireFromTest.resolve('vue-tsc/bin/vue-tsc.js'),
            '-b',
            target,
            '--pretty',
            'false',
          ],
          { cwd: fixture.rootDir },
        );
        expect(built.stderr).toBe('');
        const receipt = validation.receipts.find(
          (item) => item.sourceConfig === a,
        )!;
        expect(
          receipt.mappings.some(
            (item) =>
              item.file === fixture.path('packages/b/api.d.ts') &&
              item.sourceConfig === b &&
              item.loaded,
          ),
        ).toBe(true);
        const child =
          kind === 'retained'
            ? 'packages/b/internal.d.ts'
            : 'packages/b/api.d.ts';
        if (isButton) {
          const mapping = receipt.referenceMappings.find(
            (item) => item.file === fixture.path('packages/b/Button.vue'),
          )!;
          expect(mapping.referenceConfig).toBe(
            graph.sourceToDts.get('vue-tsc')!.get(b),
          );
          expect(mapping.declarationOutput?.endsWith('/Button.vue.d.ts')).toBe(
            true,
          );
          expect(existsSync(mapping.declarationOutput!)).toBe(true);
        } else
          expect(
            receipt.requests.some(
              (item) =>
                item.file === fixture.path(child) &&
                item.target === fixture.path('packages/c/model.ts'),
            ),
          ).toBe(true);
      } finally {
        await fixture.cleanup();
      }
    },
    60_000,
  );
  it('rejects delegated retained declarations with different actual resolution environments', async () => {
    const compilerOptions = {
      composite: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      types: [],
    };
    const fixture = await createFixture({
      'packages/a/tsconfig.json': json({
        compilerOptions: {
          ...compilerOptions,
          paths: { model: ['../d/model.ts'] },
        },
        files: ['App.vue'],
      }),
      'packages/a/App.vue':
        '<script setup lang="ts">import type { Model } from "../b/api"; let value: Model;</script>',
      'packages/b/tsconfig.json': json({
        compilerOptions: {
          ...compilerOptions,
          paths: { model: ['../c/model.ts'] },
        },
        files: ['api.d.ts'],
      }),
      'packages/b/api.d.ts': 'export type { Model } from "./internal";',
      'packages/b/internal.d.ts': 'export type { Model } from "model";',
      'packages/c/tsconfig.json': json({
        compilerOptions,
        files: ['model.ts'],
      }),
      'packages/c/model.ts': 'export interface Model { fromC: number }',
      'packages/d/tsconfig.json': json({
        compilerOptions,
        files: ['model.ts'],
      }),
      'packages/d/model.ts': 'export interface Model { fromD: number }',
    });
    fixture.config.scope!.checkers = {
      'vue-tsc': { include: ['packages/*/tsconfig.json'] },
    };
    try {
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow(
        'Declaration request context differs from its selected owner',
      );
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);
});
