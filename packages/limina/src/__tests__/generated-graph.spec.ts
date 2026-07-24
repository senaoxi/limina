import type { ResolvedLiminaConfig } from '#config/runner';
import { resolveGeneratedGraphCheckers } from '#core/build-graph/runner';
import { parseProject } from '#core/import-graph/context';
import { normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiminaStructuredError } from '../check-reporting/errors';
import { createManagedOutputDeclarationLookup } from '../core/import-graph/managed-output-provider';
import { prepareAndMaterializeGeneratedTsconfigGraph as prepareGeneratedTsconfigGraph } from './helpers/generated-graph';
import { toPortablePath } from './helpers/path';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-generated-graph-')),
  );
  const fixtureFiles = {
    'package.json': `${JSON.stringify(
      {
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

  return {
    cleanup: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    config: {
      config: {
        checkers: {
          typescript: {
            preset: 'tsc',
            include: ['packages/**/tsconfig.json'],
          },
        },
      },
      configPath: path.join(rootDir, 'limina.config.mjs'),
      rootDir,
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

async function readGeneratedReferences(options: {
  checkerName?: string;
  projectRelativePath: string;
  rootDir: string;
}): Promise<{ path: string }[]> {
  const checkerName = options.checkerName ?? 'typescript';
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
            '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.dts.json',
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
          name: 'typescript',
          preset: 'tsc',
        },
      ]);
      expect(Object.keys(result.manifest.checkers)).toEqual(['typescript']);
      expect(result.manifest.checkers.typescript?.sourceToDts).toMatchObject({
        'packages/pkg/tsconfig.json':
          '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.dts.json',
      });
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

      expect(result.manifest.checkers.typescript?.roots).toEqual([
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

      expect(result.manifest.checkers.typescript?.roots).toEqual([
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
            typescript: {
              include: ['**/tsconfig.json'],
              preset: 'tsc',
            },
          },
        },
      });
      expect(result.manifest.checkers.typescript?.roots).toEqual([
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
          name: 'typescript',
          preset: 'tsc',
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
          name: 'typescript',
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

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        config: {
          checkers: {
            mode: 'auto',
          },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          include: ['packages/app/tsconfig.json'],
          name: 'vue',
          preset: 'vue-tsc',
        },
      ]);
      expect(Object.keys(result.manifest.checkers)).toEqual(['vue']);
      expect(result.manifest.checkers.vue?.sourceToDts).toMatchObject({
        'packages/app/tsconfig.json':
          '.limina/tsconfig/checkers/vue/projects/packages/app/tsconfig.dts.json',
      });
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
          checkers: {
            mode: 'auto',
          },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          include: [
            'packages/app/tsconfig.json',
            'packages/theme/tsconfig.json',
          ],
          name: 'vue',
          preset: 'vue-tsc',
        },
      ]);
      expect(Object.keys(result.manifest.checkers)).toEqual(['vue']);
      expect(result.manifest.providerEdges).toEqual([]);
      expect(result.manifest.checkers.vue?.sourceToDts).toMatchObject({
        'packages/app/tsconfig.json':
          '.limina/tsconfig/checkers/vue/projects/packages/app/tsconfig.dts.json',
        'packages/theme/tsconfig.json':
          '.limina/tsconfig/checkers/vue/projects/packages/theme/tsconfig.dts.json',
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
          checkers: {
            mode: 'auto',
          },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          include: [
            'packages/app/tsconfig.json',
            'packages/shared/tsconfig.json',
            'packages/theme/tsconfig.json',
          ],
          name: 'vue',
          preset: 'vue-tsc',
        },
      ]);
      expect(Object.keys(result.manifest.checkers)).toEqual(['vue']);
      expect(result.manifest.providerEdges).toEqual([]);
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

    try {
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        config: {
          checkers: {
            mode: 'auto',
          },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          include: [
            'packages/app/tsconfig.json',
            'packages/shared/tsconfig.json',
          ],
          name: 'typescript',
          preset: 'tsc',
        },
      ]);
      expect(Object.keys(result.manifest.checkers)).toEqual(['typescript']);
      expect(result.manifest.providerEdges).toEqual([]);
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
          checkers: {
            mode: 'auto',
          },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          include: ['packages/app/tsconfig.json'],
          name: 'vue',
          preset: 'vue-tsc',
        },
      ]);
      expect(result.manifest.checkers.vue?.sourceToDts).toMatchObject({
        'packages/app/tsconfig.lib.json':
          '.limina/tsconfig/checkers/vue/projects/packages/app/tsconfig.lib.dts.json',
      });
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
            exclude: ['packages/playground/tsconfig.json'],
            mode: 'auto',
          },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          exclude: ['packages/playground/tsconfig.json'],
          include: ['packages/app/tsconfig.json'],
          name: 'typescript',
          preset: 'tsc',
        },
      ]);
      expect(result.manifest.checkers.typescript?.sourceToDts).toEqual({
        'packages/app/tsconfig.json':
          '.limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.dts.json',
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
            exclude: ['packages/pkg/tsconfig.test.json'],
            mode: 'auto',
          },
        },
      });

      expect(result.manifest.checkers.typescript?.roots).toEqual([
        'packages/pkg/tsconfig.lib.json',
        'packages/pkg/tsconfig.test.json',
      ]);
      expect(result.manifest.checkers.typescript?.sourceToDts).toEqual({
        'packages/pkg/tsconfig.lib.json':
          '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.lib.dts.json',
        'packages/pkg/tsconfig.test.json':
          '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.test.dts.json',
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
            exclude: ['packages/pkg/tsconfig.test.json'],
            mode: 'auto',
          },
        },
      });

      expect(result.checkers).toMatchObject([
        {
          include: ['packages/pkg/tsconfig.json'],
          name: 'typescript',
        },
      ]);
      expect(result.manifest.checkers.typescript?.roots).toEqual([
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

      expect(result.manifest.checkers.typescript?.roots).toEqual([
        'packages/pkg/tsconfig.lib.json',
        'packages/pkg/tsconfig.test.json',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects unsupported extensions in auto scopes', async () => {
    const fixture = await createFixture({
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
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          config: {
            checkers: {
              mode: 'auto',
            },
          },
        }),
      ).rejects.toThrow('Unsupported auto checker source file extension');
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
        '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.lib.dts.json';

      expect(toPortablePath(result.manifestPath)).toBe(
        toPortablePath(path.join(fixture.rootDir, '.limina/manifest.json')),
      );
      expect(result.manifest.checkers.typescript?.sourceToDts).toMatchObject({
        [sourcePath]: dtsPath,
      });
      expect(result.manifest.checkers.typescript?.dtsToSource).toMatchObject({
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
        checker: 'typescript',
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

  it('generates per-package Knip tsconfig entries from static package build scripts', async () => {
    const fixture = await createFixture({
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
    });

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
          path: '../../../tsconfig/checkers/typescript/outputs/solutions/packages/pkg/tsconfig.output.json',
        },
      ]);
      expect(result.manifest.knip.packages).toEqual([
        {
          configPath: generatedPath,
          packageDirectory: 'packages/pkg',
          packageJsonPath: 'packages/pkg/package.json',
          packageName: '@example/pkg',
          references: [
            '.limina/tsconfig/checkers/typescript/outputs/solutions/packages/pkg/tsconfig.output.json',
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
    const fixture = await createFixture({
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
    });

    try {
      const result = await prepareGeneratedTsconfigGraph(fixture.config);

      expect(result.manifest.knip.diagnostics).toEqual([]);
      expect(result.manifest.knip.packages).toEqual([
        expect.objectContaining({
          references: [
            '.limina/tsconfig/checkers/typescript/outputs/solutions/packages/pkg/tsconfig.output.json',
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

  it('records diagnostics for dynamic package build scripts without generating Knip configs', async () => {
    const fixture = await createFixture({
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
    });

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
    const fixture = await createFixture({
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
    });

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
    const fixture = await createFixture({
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
    });

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
        '.limina/tsconfig/checkers/typescript/outputs/projects/packages/pkg/tsconfig.lib.output.json';
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

      expect(result.manifest.version).toBe(3);
      expect(
        result.manifest.checkers.typescript?.configToOutputBuild,
      ).toMatchObject({
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
        '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.lib.dts.json',
      );
      const outputConfigPath = path.join(
        fixture.rootDir,
        '.limina/tsconfig/checkers/typescript/outputs/projects/packages/pkg/tsconfig.lib.output.json',
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
        '.limina/tsconfig/checkers/typescript/outputs/projects/packages/pkg/tsconfig.lib.output.json';
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
        .get('typescript')
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
        '.limina/tsconfig/checkers/typescript/outputs/solutions/packages/pkg/tsconfig.output.json';
      const solutionConfig = JSON.parse(
        await readFile(path.join(fixture.rootDir, solutionPath), 'utf8'),
      ) as {
        references: { path: string }[];
      };

      expect(
        result.manifest.checkers.typescript?.configToOutputBuild,
      ).toMatchObject({
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
              nativeTypescript: {
                include: ['packages/one/tsconfig.json'],
                preset: 'tsgo',
              },
              typescript: {
                include: ['packages/two/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(String(thrown)).toContain('Output build cache boundary conflict');
      expect(String(thrown)).toContain('packages/shared/tsconfig.lib.json');
      expect(String(thrown)).toContain(
        '.limina/tsbuildinfo/build/packages/shared/lib.tsbuildinfo',
      );
      expect(String(thrown)).toContain('nativeTypescript (tsgo, engine: tsgo)');
      expect(String(thrown)).toContain('typescript (tsc, engine: tsc)');
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
              one: {
                include: ['packages/one/tsconfig.json'],
                preset: 'tsc',
              },
              two: {
                include: ['packages/two/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
        }),
      ).rejects.toThrow('Output build cache boundary conflict');
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
              typescript: {
                include: [
                  'packages/app/tsconfig.json',
                  'packages/core/tsconfig.json',
                ],
                preset: 'tsc',
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
              typescript: {
                include: [
                  'packages/app/tsconfig.json',
                  'packages/core/tsconfig.json',
                ],
                preset: 'tsc',
              },
            },
          },
        }),
      ).resolves.toMatchObject({
        manifest: {
          checkers: {
            typescript: {
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
              typescript: {
                preset: 'tsc',
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

      expect(result.manifest.checkers.typescript?.sourceToDts).toEqual({
        'packages/pkg/tsconfig.json':
          '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.dts.json',
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
            typescript: {
              preset: 'tsc',
              include: ['packages/pkg/tsconfig.json'],
            },
          },
        },
      });

      expect(result.manifest.checkers.typescript?.roots).toEqual([
        'packages/pkg/tsconfig.json',
      ]);
      expect(result.manifest.checkers.typescript?.sourceToDts).toMatchObject({
        'packages/pkg/tsconfig.json':
          '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.dts.json',
      });
      expect(result.manifest.checkers.typescript?.sourceToBuild).toMatchObject({
        'packages/pkg/tsconfig.json': {
          kind: 'project',
          path: '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.dts.json',
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
            typescript: {
              preset: 'tsc',
              include: ['tsconfig.json'],
            },
          },
        },
      });

      expect(result.manifest.checkers.typescript?.roots).toEqual([
        'packages/pkg/tsconfig.lib.json',
        'packages/pkg/tsconfig.test.json',
      ]);

      const buildConfig = JSON.parse(
        await readFile(
          path.join(
            fixture.rootDir,
            '.limina/tsconfig/checkers/typescript/tsconfig.build.json',
          ),
          'utf8',
        ),
      ) as {
        references: { path: string }[];
      };

      expect(buildConfig.references).toEqual([
        {
          path: './solutions/tsconfig.build.json',
        },
      ]);

      const rootSolutionConfig = JSON.parse(
        await readFile(
          path.join(
            fixture.rootDir,
            '.limina/tsconfig/checkers/typescript/solutions/tsconfig.build.json',
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
            '.limina/tsconfig/checkers/typescript/solutions/packages/pkg/tsconfig.build.json',
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
      expect(result.manifest.checkers.typescript?.sourceToDts).toMatchObject({
        'packages/pkg/tsconfig.lib.json':
          '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.lib.dts.json',
        'packages/pkg/tsconfig.test.json':
          '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.test.dts.json',
      });
      expect(result.manifest.checkers.typescript?.sourceToBuild).toMatchObject({
        'tsconfig.json': {
          kind: 'solution',
          path: '.limina/tsconfig/checkers/typescript/solutions/tsconfig.build.json',
        },
        'packages/pkg/tsconfig.json': {
          kind: 'solution',
          path: '.limina/tsconfig/checkers/typescript/solutions/packages/pkg/tsconfig.build.json',
        },
        'packages/pkg/tsconfig.lib.json': {
          kind: 'project',
          path: '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.lib.dts.json',
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
            typescript: {
              preset: 'tsc',
              include: ['packages/pkg/tsconfig.json'],
              exclude: ['packages/pkg/vue/tsconfig.json'],
            },
          },
        },
      });

      expect(result.manifest.checkers.typescript?.roots).toEqual([
        'packages/pkg/tsconfig.lib.json',
        'packages/pkg/vue/tsconfig.json',
      ]);
      expect(result.manifest.checkers.typescript?.sourceToDts).toEqual({
        'packages/pkg/tsconfig.lib.json':
          '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.lib.dts.json',
        'packages/pkg/vue/tsconfig.json':
          '.limina/tsconfig/checkers/typescript/projects/packages/pkg/vue/tsconfig.dts.json',
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
              typescript: {
                preset: 'tsc',
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
              one: {
                preset: 'tsc',
                include: ['packages/pkg/tsconfig.json'],
              },
              two: {
                preset: 'tsgo',
                include: ['packages/pkg/tsconfig.json'],
              },
            },
          },
        }),
      ).rejects.toThrow('Duplicate Limina checker entry');
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
              one: {
                preset: 'tsc',
                include: ['packages/one/tsconfig.json'],
              },
              two: {
                preset: 'tsc',
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

  it('allows isolated multi-checker declaration generation for the same source config', async () => {
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
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        config: {
          checkers: {
            typescript: {
              preset: 'tsc',
              include: ['packages/two/tsconfig.json'],
            },
            nativeTypescript: {
              preset: 'tsgo',
              include: ['packages/one/tsconfig.json'],
            },
          },
        },
      });

      expect(Object.keys(result.manifest.checkers)).toEqual([
        'nativeTypescript',
        'typescript',
      ]);
      expect(
        result.manifest.checkers.nativeTypescript?.sourceToDts,
      ).toMatchObject({
        'packages/shared/tsconfig.lib.json':
          '.limina/tsconfig/checkers/nativeTypescript/projects/packages/shared/tsconfig.lib.dts.json',
      });
      expect(result.manifest.checkers.typescript?.sourceToDts).toMatchObject({
        'packages/shared/tsconfig.lib.json':
          '.limina/tsconfig/checkers/typescript/projects/packages/shared/tsconfig.lib.dts.json',
      });
      expect(result.manifest.providerEdges).toEqual([]);
      expect(
        result.manifest.checkers.nativeTypescript?.configToOutputBuild,
      ).toEqual({});
      expect(result.manifest.checkers.typescript?.configToOutputBuild).toEqual(
        {},
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects source configs with files unsupported by checker coverage', async () => {
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
      await expect(
        prepareGeneratedTsconfigGraph(fixture.config),
      ).rejects.toThrow(
        'Source config contains files unsupported by its checker coverage',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows source files when another checker preset supplies the capability', async () => {
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
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        config: {
          checkers: {
            typescript: {
              preset: 'tsc',
              include: ['packages/ts/tsconfig.json'],
            },
            vue: {
              preset: 'vue-tsc',
              include: ['packages/vue/tsconfig.json'],
            },
          },
        },
      });

      expect(result.manifest.checkers.vue?.sourceToDts).toMatchObject({
        'packages/shared/tsconfig.lib.json':
          '.limina/tsconfig/checkers/vue/projects/packages/shared/tsconfig.lib.dts.json',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('records same-engine cross-checker provider edges for static imports', async () => {
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
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        config: {
          checkers: {
            appTypescript: {
              preset: 'tsc',
              include: ['packages/app/tsconfig.json'],
            },
            themeTypescript: {
              preset: 'tsc',
              include: ['packages/theme/tsconfig.json'],
            },
          },
        },
      });

      expect(result.manifest.providerEdges).toEqual([
        {
          file: 'packages/app/src/index.ts:1 (kind: static)',
          fromChecker: 'appTypescript',
          fromConfig: 'packages/app/tsconfig.json',
          importedSpecifier: '../../theme/src/theme',
          resolvedFile: 'packages/theme/src/theme.ts',
          toChecker: 'themeTypescript',
          toConfig: 'packages/theme/tsconfig.json',
        },
      ]);
      expect(result.providerEdges).toHaveLength(1);

      const generatedConfig = JSON.parse(
        await readFile(
          path.join(
            fixture.rootDir,
            '.limina/tsconfig/checkers/appTypescript/projects/packages/app/tsconfig.dts.json',
          ),
          'utf8',
        ),
      ) as {
        references: { path: string }[];
      };

      expect(generatedConfig.references).toEqual([
        {
          path: '../../../../themeTypescript/projects/packages/theme/tsconfig.dts.json',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('prefers a unique same-engine provider over different-engine candidates', async () => {
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
      const result = await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        config: {
          checkers: {
            app: {
              preset: 'tsc',
              include: ['packages/app/tsconfig.json'],
            },
            themeTypescript: {
              preset: 'tsc',
              include: ['packages/theme-ts/tsconfig.json'],
            },
            themeVue: {
              preset: 'vue-tsc',
              include: ['packages/theme-vue/tsconfig.json'],
            },
          },
        },
      });

      expect(result.manifest.providerEdges).toEqual([
        {
          file: 'packages/app/src/index.ts:1 (kind: static)',
          fromChecker: 'app',
          fromConfig: 'packages/app/tsconfig.json',
          importedSpecifier: '../../theme/src/theme',
          resolvedFile: 'packages/theme/src/theme.ts',
          toChecker: 'themeTypescript',
          toConfig: 'packages/theme/tsconfig.lib.json',
        },
      ]);
      await expect(
        readGeneratedReferences({
          checkerName: 'app',
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).resolves.toEqual([
        {
          path: '../../../../themeTypescript/projects/packages/theme/tsconfig.lib.dts.json',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects cross-engine provider fallback before writing provider references', async () => {
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
      let thrown: unknown;

      try {
        await prepareGeneratedTsconfigGraph({
          ...fixture.config,
          config: {
            checkers: {
              typescript: {
                preset: 'tsc',
                include: ['packages/app/tsconfig.json'],
              },
              vue: {
                preset: 'vue-tsc',
                include: ['packages/theme/tsconfig.json'],
              },
            },
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(String(thrown)).toContain(
        'Unsafe cross-engine declaration provider',
      );
      expect(String(thrown)).toContain(
        'consumer checker: typescript (tsc, engine: tsc)',
      );
      expect(String(thrown)).toContain(
        'target config: packages/theme/tsconfig.json',
      );
      expect(String(thrown)).toContain('vue (vue-tsc, engine: vue-tsc)');
      expect(String(thrown)).toContain('packages/theme/src/theme.ts');
      expect(thrown).toBeInstanceOf(LiminaStructuredError);

      const issue = (thrown as LiminaStructuredError).issues.find(
        (item) => item.title === 'Unsafe cross-engine declaration provider',
      );

      expect(issue).toMatchObject({
        detector: 'graph-prepare',
        filePath: 'packages/app/src/index.ts',
        fix: 'Make the target config owned by the consumer checker, choose one build checker owner, or split the dependency through an explicit declaration/artifact boundary.',
        reason:
          'Generated project references must not cross checker build-engine boundaries in V1.',
        summary:
          'typescript cannot use provider candidates from different build engines.',
        title: 'Unsafe cross-engine declaration provider',
      });
      expect(issue?.locations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filePath: 'packages/app/tsconfig.json',
            label: 'consumer config',
          }),
          expect.objectContaining({
            filePath: 'packages/theme/tsconfig.json',
            label: 'target config',
          }),
          expect.objectContaining({
            filePath: 'packages/theme/src/theme.ts',
            label: 'resolved file',
          }),
        ]),
      );
      expect(issue?.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'provider candidates',
            lines: ['- vue (vue-tsc, engine: vue-tsc)'],
          }),
          expect.objectContaining({
            label: 'example',
            lines: expect.arrayContaining([
              'target config: packages/theme/tsconfig.json',
            ]),
          }),
        ]),
      );
      expect(
        existsSync(
          path.join(
            fixture.rootDir,
            '.limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.dts.json',
          ),
        ),
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects ambiguous same-engine provider fallback before writing provider references', async () => {
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
              app: {
                preset: 'tsc',
                include: ['packages/app/tsconfig.json'],
              },
              themeOne: {
                preset: 'tsc',
                include: ['packages/theme-one/tsconfig.json'],
              },
              themeTwo: {
                preset: 'tsc',
                include: ['packages/theme-two/tsconfig.json'],
              },
            },
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(String(thrown)).toContain(
        'Ambiguous cross-checker declaration provider',
      );
      expect(String(thrown)).toContain('themeOne (tsc, engine: tsc)');
      expect(String(thrown)).toContain('themeTwo (tsc, engine: tsc)');
      expect(thrown).toBeInstanceOf(LiminaStructuredError);

      const issue = (thrown as LiminaStructuredError).issues.find(
        (item) => item.title === 'Ambiguous cross-checker declaration provider',
      );

      expect(issue).toMatchObject({
        detector: 'graph-prepare',
        fix: 'Make checker ownership unambiguous with config.checkers.<checker>.include/exclude.',
        reason: 'Limina cannot choose a stable generated declaration provider.',
        summary:
          'Multiple build-capable provider checkers can own the resolved file.',
        title: 'Ambiguous cross-checker declaration provider',
      });
      expect(issue?.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'candidates',
            lines: expect.arrayContaining([
              '- themeOne (tsc, engine: tsc)',
              '- themeTwo (tsc, engine: tsc)',
            ]),
          }),
        ]),
      );
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
            typescript: {
              preset: 'tsc',
              include: ['packages/app/tsconfig.json'],
            },
            vue: {
              preset: 'vue-tsc',
              include: ['packages/theme/tsconfig.json'],
            },
          },
        },
      });

      expect(result.manifest.providerEdges).toEqual([]);
      expect(result.providerEdges).toEqual([]);
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
              typescript: {
                preset: 'tsc',
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
              '.limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.dts.json',
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
            typescript: {
              preset: 'tsc',
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
            '.limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.dts.json',
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

  it('writes same-checker references for managed output declaration providers', async () => {
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

      await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        config: {
          checkers: {
            typescript: {
              preset: 'tsc',
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
      ).resolves.toEqual([
        {
          path: '../provider/tsconfig.dts.json',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reverse-maps Vue managed output declarations to owned Vue sources', async () => {
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

      await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        config: {
          checkers: {
            vue: {
              include: [
                'packages/app/tsconfig.json',
                'packages/theme/tsconfig.json',
              ],
              preset: 'vue-tsc',
            },
          },
        },
      });

      await expect(
        readGeneratedReferences({
          checkerName: 'vue',
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).resolves.toEqual([
        {
          path: '../theme/tsconfig.dts.json',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes output build references from managed output source refs', async () => {
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

      await prepareGeneratedTsconfigGraph({
        ...fixture.config,
        config: {
          checkers: {
            typescript: {
              preset: 'tsc',
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
            '.limina/tsconfig/checkers/typescript/outputs/projects/packages/app/tsconfig.output.json',
          ),
          'utf8',
        ),
      ) as {
        references: { path: string }[];
      };

      expect(outputConfig.references).toEqual([
        {
          path: '../provider/tsconfig.output.json',
        },
      ]);
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
            typescript: {
              preset: 'tsc',
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
            typescript: {
              preset: 'tsc',
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
            typescript: {
              preset: 'tsc',
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

  it('applies deny refs to managed output mapped source configs', async () => {
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

      await prepareGeneratedTsconfigGraph({
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
            typescript: {
              preset: 'tsc',
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

  it('uses mapped sources for same-engine cross-checker managed output providers', async () => {
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
            appTypescript: {
              preset: 'tsc',
              include: ['packages/app/tsconfig.json'],
            },
            providerTypescript: {
              preset: 'tsc',
              include: ['packages/provider/tsconfig.json'],
            },
          },
        },
      });

      expect(result.manifest.providerEdges).toEqual([
        {
          file: 'packages/app/src/index.ts:1 (kind: static)',
          fromChecker: 'appTypescript',
          fromConfig: 'packages/app/tsconfig.json',
          importedSpecifier: '@example/provider',
          resolvedFile: 'packages/provider/dist/index.d.ts',
          toChecker: 'providerTypescript',
          toConfig: 'packages/provider/tsconfig.json',
        },
      ]);
      await expect(
        readGeneratedReferences({
          checkerName: 'appTypescript',
          projectRelativePath: 'packages/app',
          rootDir: fixture.rootDir,
        }),
      ).resolves.toEqual([
        {
          path: '../../../../providerTypescript/projects/packages/provider/tsconfig.dts.json',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects multi-checker managed output source identities', async () => {
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

      let thrown: unknown;

      try {
        await prepareGeneratedTsconfigGraph({
          ...fixture.config,
          config: {
            checkers: {
              typescript: {
                preset: 'tsc',
                include: [
                  'packages/app/tsconfig.json',
                  'packages/provider/tsconfig.json',
                ],
              },
              vue: {
                preset: 'vue-tsc',
                include: ['tsconfig.json'],
              },
            },
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(String(thrown)).toContain('Output build cache boundary conflict');
      expect(String(thrown)).toContain('packages/provider/tsconfig.json');
      expect(String(thrown)).toContain(
        '.limina/tsbuildinfo/build/packages/provider/tsconfig.tsbuildinfo',
      );
      expect(thrown).toBeInstanceOf(LiminaStructuredError);

      const issue = (thrown as LiminaStructuredError).issues.find(
        (item) => item.title === 'Output build cache boundary conflict',
      );

      expect(issue).toMatchObject({
        detector: 'graph-prepare',
        filePath: 'packages/provider/tsconfig.json',
        fix: 'Choose one output build checker owner for this config, or split output-enabled configs so each output build boundary has one owner.',
        reason:
          'Generated output build info is keyed by source config path and is not checker-namespaced.',
        summary:
          'Multiple checkers would generate output build configs for the same output-enabled source config.',
        title: 'Output build cache boundary conflict',
      });
      expect(issue?.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'build owners',
            lines: expect.arrayContaining([
              '- typescript (tsc, engine: tsc)',
              '- vue (vue-tsc, engine: vue-tsc)',
            ]),
          }),
        ]),
      );
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
            vue: {
              preset: 'vue-tsc',
              include: [
                'packages/app/tsconfig.json',
                'packages/theme/tsconfig.json',
              ],
            },
          },
        },
      });

      expect(result.manifest.providerEdges).toEqual([]);

      const generatedConfig = JSON.parse(
        await readFile(
          path.join(
            fixture.rootDir,
            '.limina/tsconfig/checkers/vue/projects/packages/app/tsconfig.dts.json',
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
            vue: {
              preset: 'vue-tsc',
              include: [
                'packages/app/tsconfig.json',
                'packages/theme/tsconfig.json',
              ],
            },
          },
        },
      });

      expect(result.manifest.providerEdges).toEqual([]);
      expect(
        await readGeneratedReferences({
          checkerName: 'vue',
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

      expect(result.manifest.providerEdges).toEqual([]);
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

  it('reports Oxc-only Vue providers under plain TypeScript checkers', async () => {
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

    try {
      await expect(
        prepareGeneratedTsconfigGraph({
          ...fixture.config,
          config: {
            checkers: {
              typescript: {
                preset: 'tsc',
                include: ['packages/app/tsconfig.json'],
              },
            },
          },
        }),
      ).rejects.toThrow(
        'Oxc can resolve this specifier, but TypeScript cannot',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('removes stale generated tsconfig files', async () => {
    const fixture = await createFixture({
      '.limina/manifest.json': json({
        generatedBy: 'limina',
        ownedArtifacts: [
          'tsconfig/checkers/typescript/projects/stale/tsconfig.dts.json',
          'manifest.json',
        ],
        version: 3,
      }),
      '.limina/tsconfig/checkers/typescript/projects/stale/tsconfig.dts.json':
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
            '.limina/tsconfig/checkers/typescript/projects/stale/tsconfig.dts.json',
          ),
        ),
      ).toBe(false);
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
            '.limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.lib.dts.json',
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
            '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.runtime.dts.json',
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
        await expect(
          prepareGeneratedTsconfigGraph(fixture.config),
        ).rejects.toThrow(caseValue.expected);
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
