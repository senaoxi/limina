import type { ResolvedLiminaConfig, SourceCheckConfig } from '#config/runner';
import { resolveGeneratedGraphCheckers } from '#core/build-graph/runner';
import {
  createImportAnalysisContext,
  parseProject,
} from '#core/import-graph/context';
import { normalizeAbsolutePath } from '#utils/path';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
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
import { describe, expect, it, vi } from 'vitest';
import { LiminaStructuredError } from '../check-reporting/errors';
import { createManagedOutputDeclarationLookup } from '../core/import-graph/managed-output-provider';
import { prepareAndMaterializeGeneratedTsconfigGraph as prepareGeneratedTsconfigGraph } from './helpers/generated-graph';
import { toPortablePath } from './helpers/path';

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

async function linkAstroToolchain(rootDir: string): Promise<void> {
  await Promise.all([
    linkInstalledPackage({
      installedName: '@astrojs/check',
      packageName: '@astrojs/check',
      rootDir,
    }),
    linkInstalledPackage({
      installedName: 'astro-v7-current',
      packageName: 'astro',
      rootDir,
    }),
    linkInstalledPackage({
      installedName: 'typescript',
      packageName: 'typescript',
      rootDir,
    }),
  ]);
}

async function linkVueToolchain(rootDir: string): Promise<void> {
  const vueTscPackagePath = requireFromTest.resolve('vue-tsc/package.json');
  const nodeModulesDir = path.join(rootDir, 'node_modules');

  await mkdir(nodeModulesDir, { recursive: true });
  await symlink(
    path.dirname(vueTscPackagePath),
    path.join(nodeModulesDir, 'vue-tsc'),
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
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-generated-graph-')),
  );
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
              '@astrojs/check': '0.9.10',
              astro: '7.2.0',
              typescript: '6.0.3',
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
    await writeText(path.join(rootDir, relativePath), text);
  }
  await linkVueToolchain(rootDir);
  if (hasSvelte && !hasAstro) {
    await linkInstalledPackage({
      installedName: 'typescript',
      packageName: 'typescript',
      rootDir,
    });
  }
  if (options.svelteCompiler !== false && hasSvelte) {
    await linkInstalledPackage({
      installedName: 'svelte-v4-min',
      packageName: 'svelte',
      rootDir,
    });
  }
  if (options.svelteTransform !== false && hasSvelte) {
    await linkInstalledPackage({
      installedName: 'svelte2tsx',
      packageName: 'svelte2tsx',
      rootDir,
    });
  }
  if (options.astroToolchain !== false && hasAstro) {
    await linkAstroToolchain(rootDir);
  }

  return {
    cleanup: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    config: {
      config: {
        checkers: {
          tsc: {
            include: ['packages/**/tsconfig.json'],
          },
        },
      },
      configPath: path.join(rootDir, 'limina.config.mjs'),
      rootDir,
      source: options.source,
    },
    rootDir,
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function linkWorkspacePackage(
  rootDir: string,
  importer: string,
  target: string,
  packageName: string,
): Promise<void> {
  const [scope, name] = packageName.split('/');
  const nodeModulesDir =
    scope && name
      ? path.join(rootDir, importer, 'node_modules', scope)
      : path.join(rootDir, importer, 'node_modules');

  await mkdir(nodeModulesDir, {
    recursive: true,
  });
  await symlink(
    path.relative(nodeModulesDir, path.join(rootDir, target)),
    path.join(nodeModulesDir, name ?? packageName),
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
  const resolveOxcImport = vi.fn(base.resolveOxcImport);
  return {
    context: { ...base, resolveOxcImport },
    resolveOxcImport,
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
        config: { checkers: { auto: {} } },
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

  it('does not override explicitly configured typeRoots in generated declarations', async () => {
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
        config: { checkers: { auto: {} } },
      });
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
      ) as { compilerOptions: Record<string, unknown> };
      expect(generatedConfig.compilerOptions.typeRoots).toBeUndefined();
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
        config: { checkers: { auto: {} } },
      });
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
      ) as { compilerOptions: Record<string, unknown> };
      expect(generatedConfig.compilerOptions.typeRoots).toBeUndefined();
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
        config: { checkers: { auto: {} } },
      });
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
      ) as { compilerOptions: Record<string, unknown> };
      expect(generatedConfig.compilerOptions.typeRoots).toBeUndefined();
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

  it('disables relative import rewriting for generated declaration projects', async () => {
    const fixture = await createFixture({
      'packages/pkg/package.json': json({
        name: '@example/pkg',
        private: true,
      }),
      'packages/pkg/src/index.ts': "export { value } from './value.ts';\n",
      'packages/pkg/src/value.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          allowImportingTsExtensions: true,
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
      await prepareGeneratedTsconfigGraph(fixture.config);
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
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ['Button.d.ts', 'Button.ts'],
    ['Button.d.ts', 'Button.tsx'],
    ['Button.d.mts', 'Button.mts'],
    ['Button.d.cts', 'Button.cts'],
    ['Button.vue.d.ts', 'Button.vue'],
  ])(
    'reverse-maps managed %s output to owned %s source',
    (declarationName, sourceName) => {
      const rootDir = path.join(process.cwd(), 'virtual-managed-source');
      const sourceFilePath = path.join(rootDir, 'src', sourceName);
      const lookup = createManagedOutputDeclarationLookup([
        {
          checkerName: 'test',
          extensions: ['.ts', '.tsx', '.mts', '.cts', '.vue'],
          outputOptions: {
            outDir: path.join(rootDir, 'dist'),
            rootDir: path.join(rootDir, 'src'),
          },
          ownedFileNames: [sourceFilePath],
          sourceConfigPath: path.join(rootDir, 'tsconfig.json'),
        },
      ]);

      expect(
        toPortablePath(
          lookup.resolve(path.join(rootDir, 'dist', declarationName))!
            .mappedSourceFilePath,
        ),
      ).toBe(toPortablePath(sourceFilePath));
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
      fixture.config.regions = {
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

  it('uses auto checkers when config.checkers is omitted', async () => {
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
        config: {},
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
        config: { checkers: { auto: { useTsgo: true } } },
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
        config: {
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
        config: {},
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
        config: {},
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
        /Referenced checker source config is outside activated workspace package regions:[\s\S]*boundary kind: pnpm-workspace[\s\S]*packages\/a\/fixture/u,
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
      await writeText(
        path.join(fixture.rootDir, 'packages/a/tsconfig.json'),
        json({
          files: [],
          references: [
            {
              path: path.relative(
                path.join(fixture.rootDir, 'packages/a'),
                outsideConfigPath,
              ),
            },
          ],
        }),
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
          config: {},
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
          config: {
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
      expect(analysis.resolveOxcImport).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

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
          config: { checkers: { auto: {} } },
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
      expect(analysis.resolveOxcImport).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses the owning leaf package root for framework imports in auto scopes', async () => {
    const fixture = await createFixture(
      {
        'packages/app/package.json': json({
          dependencies: {
            '@astrojs/check': '0.9.10',
            astro: '7.2.0',
            typescript: '6.0.3',
          },
          name: '@fixture/app',
          private: true,
        }),
        'packages/app/src/Page.astro':
          '---\nimport value from "./value";\nvoid value;\n---\n',
        'packages/app/src/value.ts': 'export default 1;\n',
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
        config: { checkers: { auto: {} } },
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
        config: {
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
        config: {
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
        config: {
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
          config: {
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
      expect(analysis.resolveOxcImport).not.toHaveBeenCalled();
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
          config: { checkers: { auto: {} } },
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
            config: { checkers: { auto: {} } },
          },
          { importAnalysisContext: analysis.context },
        ),
      ).rejects.toThrow(
        /multiple framework checker requirements[\s\S]*astro[\s\S]*svelte-check/u,
      );
      expect(analysis.resolveOxcImport).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('propagates one framework constraint across overlapping solutions through a shared pending leaf', async () => {
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
        config: { checkers: { auto: {} } },
      });
      expect(result.manifest.ownership.configs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            config: 'packages/b/tsconfig.lib.json',
            owner: 'svelte-check',
          }),
          expect.objectContaining({
            config: 'packages/shared/tsconfig.lib.json',
            owner: 'svelte-check',
          }),
        ]),
      );
      expect(
        new Set(result.manifest.ownership.solutions.map(({ owner }) => owner)),
      ).toEqual(new Set(['svelte-check']));
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
        config: { checkers: { auto: {} } },
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

  it('respects an ambient module contract as a framework domain boundary', async () => {
    const fixture = await createFixture({
      'packages/consumer/src/framework.d.ts':
        "declare module '*.svelte' { const component: unknown; export default component; }\n",
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
          config: { checkers: { auto: {} } },
        },
        { importAnalysisContext: analysis.context },
      );
      expect(checkers).toMatchObject([
        {
          include: ['packages/svelte/tsconfig.json'],
          name: 'svelte-check',
        },
        { include: ['packages/consumer/tsconfig.json'], name: 'tsc' },
      ]);
      expect(analysis.resolveOxcImport).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('respects a concrete declaration as a framework domain boundary', async () => {
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
      'packages/svelte/src/App.d.svelte.ts':
        'declare const component: unknown;\nexport default component;\n',
      'packages/svelte/src/App.svelte': '<h1>Svelte</h1>\n',
      'packages/svelte/tsconfig.json': json({ include: ['src/**/*'] }),
    });
    const analysis = createSpiedImportAnalysis();

    try {
      const result = await prepareGeneratedTsconfigGraph(
        {
          ...fixture.config,
          config: { checkers: { auto: {} } },
        },
        { importAnalysisContext: analysis.context },
      );
      expect(result.manifest.ownership.configs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            config: 'packages/consumer/tsconfig.json',
            owner: 'tsc',
          }),
        ]),
      );
      expect(result.ownershipPlan.dependencyFacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            consumerConfigPath: normalizeAbsolutePath(
              path.join(fixture.rootDir, 'packages/consumer/tsconfig.json'),
            ),
            typeEvidenceKind: 'concrete-declaration',
          }),
        ]),
      );
      expect(analysis.resolveOxcImport).not.toHaveBeenCalled();
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
          config: {
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
        expect(result.ownershipPlan.dependencyFacts).toEqual([]);
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
          config: {
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

  it('does not propagate ownership from a framework file excluded from its nearby config', async () => {
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
      const checkers = await resolveGeneratedGraphCheckers({
        ...fixture.config,
        config: { checkers: { auto: {} } },
      });
      expect(checkers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            include: ['packages/consumer/tsconfig.json'],
            name: 'tsc',
          }),
          expect.objectContaining({
            include: ['packages/svelte/tsconfig.json'],
            name: 'svelte-check',
          }),
        ]),
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
          config: { checkers: { auto: {} } },
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
          config: {
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
      expect(analysis.resolveOxcImport).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps pending resource dependencies out of Oxc ownership discovery', async () => {
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
            config: { checkers: { auto: {} } },
          },
          { importAnalysisContext: analysis.context },
        ),
      ).resolves.toMatchObject([
        { include: ['packages/app/tsconfig.json'], name: 'tsc' },
      ]);
      expect(analysis.resolveOxcImport).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

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
    const resolveOxcImport = vi.fn(() => ordinaryTarget);

    try {
      await expect(
        resolveGeneratedGraphCheckers(
          {
            ...fixture.config,
            config: { checkers: { auto: {} } },
          },
          {
            importAnalysisContext: { ...base, resolveOxcImport },
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
        config: {
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
        config: {
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
          config: {
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
        config: {
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
        config: {
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
        config: {
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
        config: {},
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
            config: {
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
        expect(analysis.resolveOxcImport).not.toHaveBeenCalled();
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
        config: {
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
        config: {
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
          config: {
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
        config: {
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
            config: { checkers: { auto: {} } },
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
          config: { checkers: { auto: {} } },
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
      fixture.config.config = {
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
          config: { checkers: { auto: {} } },
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
          config: { checkers: { auto: {} } },
        }),
      ).rejects.toThrow('Limina only projects TypeScript declaration builds');
    } finally {
      await fixture.cleanup();
    }
  });

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
        config: { checkers: { auto: {} } },
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
  });

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
        config: { checkers: { auto: {} } },
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

      expect(result.dependencyEdges).toEqual(
        expect.arrayContaining([
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
            file: expect.stringContaining(
              'packages/vue-target/src/Widget.vue:',
            ),
            fromConfigPath: vueConfigPath,
            importedSpecifier: '../../vue-provider/src/index.ts',
            kind: 'declaration-provider',
            toConfigPath: vueProviderConfigPath,
          }),
        ]),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('deduplicates one Astro semantic root cause across records and consumers', async () => {
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
          { ...fixture.config, config: { checkers: { auto: {} } } },
          { importAnalysisContext: importAnalysis },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(LiminaStructuredError);
      expect(String(thrown)).toContain(
        'Missing Astro semantic toolchain dependency',
      );
      expect((thrown as LiminaStructuredError).issues).toHaveLength(1);
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
        config: { checkers: { auto: {} } },
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
          config: { checkers: { auto: {} } },
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
    'converts Svelte parser failures into generated-graph structured diagnostics',
    async ({ expected, file, svelteCompiler, svelteTransform }) => {
      const fixture = await createFixture(
        {
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
            config: { checkers: { auto: {} } },
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(LiminaStructuredError);
        expect(String(thrown)).toContain(expected);
        expect((thrown as LiminaStructuredError).issues).toMatchObject([
          { code: 'LIMINA_GRAPH_PREPARE_FAILED' },
        ]);
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
          config: { checkers: { auto: {} } },
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
      expect(analysis.resolveOxcImport).toHaveBeenCalledTimes(1);
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
      expect(generatedConfig.extends).toEqual([
        toPortablePath(
          path.relative(
            path.dirname(path.join(fixture.rootDir, dtsPath)),
            path.join(fixture.rootDir, sourcePath),
          ),
        ),
      ]);
      expect(generatedConfig.files).toEqual([
        toPortablePath(
          path.relative(
            path.dirname(path.join(fixture.rootDir, dtsPath)),
            path.join(fixture.rootDir, 'packages/pkg/src/index.ts'),
          ),
        ),
      ]);
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
        path.join(fixture.rootDir, '.limina/dts/checkers/tsc/packages/pkg/lib'),
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
          '.limina/dts/checkers/tsc/packages/pkg/tsconfig',
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
        '.limina/dts/checkers/tsc/packages/pkg/lib/index.d.ts',
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

      expect(result.manifest.version).toBe(5);
      expect(result.manifest.checkers.tsc?.configToOutputBuild).toMatchObject({
        [sourcePath]: {
          kind: 'project',
          path: outputPath,
        },
      });
      expect(outputConfig.compilerOptions).toMatchObject({
        composite: true,
        declaration: true,
        declarationMap: false,
        declarationDir: toPortablePath(
          path.relative(
            path.dirname(outputConfigPath),
            path.join(fixture.rootDir, 'packages/pkg/dist'),
          ),
        ),
        emitDeclarationOnly: false,
        incremental: true,
        noEmit: false,
        outDir: toPortablePath(
          path.relative(
            path.dirname(outputConfigPath),
            path.join(fixture.rootDir, 'packages/pkg/dist'),
          ),
        ),
        rootDir: toPortablePath(
          path.relative(
            path.dirname(outputConfigPath),
            path.join(fixture.rootDir, 'packages/pkg/src'),
          ),
        ),
        target: 'ES2022',
        tsBuildInfoFile: toPortablePath(
          path.relative(
            path.dirname(outputConfigPath),
            path.join(
              fixture.rootDir,
              '.limina/tsbuildinfo/build/packages/pkg/lib.tsbuildinfo',
            ),
          ),
        ),
      });
      expect(outputConfig.compilerOptions.declarationDir).toBe(
        outputConfig.compilerOptions.outDir,
      );
      expect(outputConfig.extends).toEqual([
        toPortablePath(
          path.relative(
            path.dirname(outputConfigPath),
            path.join(fixture.rootDir, sourcePath),
          ),
        ),
      ]);
      expect(outputConfig.files).toEqual([
        toPortablePath(
          path.relative(
            path.dirname(outputConfigPath),
            path.join(fixture.rootDir, 'packages/pkg/src/index.ts'),
          ),
        ),
      ]);
      expect(outputConfig.include).toEqual([]);
      expect(outputConfig.references).toEqual([]);
      expect(outputConfig.liminaOptions.sourceConfig).toBe(
        toPortablePath(
          path.relative(
            path.dirname(outputConfigPath),
            path.join(fixture.rootDir, sourcePath),
          ),
        ),
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
          .sort();

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
          config: {
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
          config: {
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
          config: {
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

  it('does not require outputs for declaration provider boundaries', async () => {
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
          config: {
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
      ).resolves.toMatchObject({
        manifest: {
          checkers: {
            tsc: {
              configToOutputBuild: {
                'packages/app/tsconfig.json': {
                  kind: 'project',
                },
              },
            },
          },
        },
      });
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
          config: {
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
        config: {
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
        config: {
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
          path: './solutions/packages/pkg/tsconfig.build.json',
        },
        {
          path: './solutions/tsconfig.build.json',
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
          path: './packages/pkg/tsconfig.build.json',
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
        config: {
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
          config: {
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
          config: {
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
          config: {
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

  it('rejects same-preset checkers that share a solution-expanded leaf', async () => {
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
          config: {
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
          config: {
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
        config: { checkers: { auto: {} } },
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
          config: {
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
        config: {
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

  it('rejects different build checker identities in one import component', async () => {
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
          config: {
            checkers: {
              tsc: {
                include: ['packages/app/tsconfig.json'],
              },
              tsgo: {
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
          config: {
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
          config: {
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
          config: {
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
        config: {
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
          config: {
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

  it('does not write references for TypeScript declaration providers', async () => {
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
        config: {
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

      expect(generatedConfig.references).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

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
        config: {
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
      'packages/theme/dist/Button.js': 'export default {};\n',
      'packages/theme/dist/Button.vue.d.ts':
        'declare const Button: unknown;\nexport default Button;\n',
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
        config: {
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
        config: {
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
        config: {
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

  it('keeps source-owned declarations without outputs as declaration boundaries', async () => {
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
        config: {
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
        config: {
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
        config: {
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
        config: {
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
          config: {
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
        config: {
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
        config: {
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

  it('does not reference a cross-project hand-written arbitrary-extension declaration', async () => {
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
      'packages/theme/src/button.d.css.ts':
        'declare const className: string;\nexport default className;\n',
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

      expect(result.manifest.dependencyEdges).toEqual([]);
      expect(
        await readGeneratedReferences({
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).toEqual([]);
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
            config: {
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
        expect(manifest.version).toBe(5);
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
        version: 6,
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

  const invalidImplicitRefCases: {
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

  it.each(invalidImplicitRefCases)(
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
                config: {
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
