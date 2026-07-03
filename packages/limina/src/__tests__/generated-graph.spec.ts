import type { ResolvedLiminaConfig } from '#config/runner';
import { prepareGeneratedTsconfigGraph } from '#core/build-graph/runner';
import { existsSync } from 'node:fs';
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

describe('prepareGeneratedTsconfigGraph', () => {
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

  it('respects auto checker exclude when expanding solution references', async () => {
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
      ]);
      expect(result.manifest.checkers.typescript?.sourceToDts).toEqual({
        'packages/pkg/tsconfig.lib.json':
          '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.lib.dts.json',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('drops auto scopes when all referenced leaves are excluded', async () => {
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

      expect(result.checkers).toEqual([]);
      expect(result.manifest.checkers).toEqual({});
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
        liminaOptions: Record<string, unknown>;
      };

      expect(generatedConfig.compilerOptions.composite).toBe(true);
      expect(generatedConfig.compilerOptions.emitDeclarationOnly).toBe(true);
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
          reason: 'Unknown option: --checker. Use --preset instead.',
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
            tsBuildInfoFile: './dist/.lib_tsbuildinfo',
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
        liminaOptions: Record<string, unknown>;
        references?: { path: string }[];
      };

      expect(result.manifest.version).toBe(2);
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
            path.join(fixture.rootDir, 'packages/pkg/dist/.lib_tsbuildinfo'),
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
      const sourceConfigPath = path.join(
        fixture.rootDir,
        'packages/pkg/tsconfig.lib.json',
      );
      const copyContexts = result.outputDeclarationCopies
        .get('typescript')
        ?.get(sourceConfigPath);

      expect(copyContexts).toHaveLength(1);
      expect(copyContexts?.[0]).toMatchObject({
        outDir: path.join(fixture.rootDir, 'packages/pkg/dist'),
        rootDir: path.join(fixture.rootDir, 'packages/pkg/src'),
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

  it('preserves checker-scoped output build mappings for shared source configs', async () => {
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
      const result = await prepareGeneratedTsconfigGraph({
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

      expect(
        result.manifest.checkers.nativeTypescript?.configToOutputBuild,
      ).toMatchObject({
        'packages/shared/tsconfig.lib.json': {
          path: '.limina/tsconfig/checkers/nativeTypescript/outputs/projects/packages/shared/tsconfig.lib.output.json',
        },
      });
      expect(
        result.manifest.checkers.typescript?.configToOutputBuild,
      ).toMatchObject({
        'packages/shared/tsconfig.lib.json': {
          path: '.limina/tsconfig/checkers/typescript/outputs/projects/packages/shared/tsconfig.lib.output.json',
        },
      });
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

  it('respects checker exclude when expanding solution tsconfig references', async () => {
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
      ]);
      expect(result.manifest.checkers.typescript?.sourceToDts).toEqual({
        'packages/pkg/tsconfig.lib.json':
          '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.lib.dts.json',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('expands default tsconfig.json references and leaves aggregator shape validation to proof', async () => {
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
        'packages/pkg/tsconfig.lib.json',
      ]);
      expect(result.manifest.checkers.typescript?.sourceToDts).toEqual({
        'packages/pkg/tsconfig.lib.json':
          '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.lib.dts.json',
      });
      expect(result.manifest.checkers.typescript?.sourceToBuild).toMatchObject({
        'packages/pkg/tsconfig.json': {
          kind: 'solution',
          path: '.limina/tsconfig/checkers/typescript/solutions/packages/pkg/tsconfig.build.json',
        },
      });
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

  it('allows different presets to share the same source config', async () => {
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

  it('records cross-checker provider edges for static imports', async () => {
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

      expect(result.manifest.providerEdges).toEqual([
        {
          file: 'packages/app/src/index.ts:1 (kind: static)',
          fromChecker: 'typescript',
          fromConfig: 'packages/app/tsconfig.json',
          importedSpecifier: '../../theme/src/theme',
          resolvedFile: 'packages/theme/src/theme.ts',
          toChecker: 'vue',
          toConfig: 'packages/theme/tsconfig.json',
        },
      ]);
      expect(result.providerEdges).toHaveLength(1);

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
          path: '../../../../vue/projects/packages/theme/tsconfig.dts.json',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes same-checker declaration references for static imports', async () => {
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
  });

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
