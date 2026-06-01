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
import { runGraphCheck } from '../commands/graph';
import { runPaths } from '../commands/paths';
import type { ResolvedLiminaConfig } from '../config';

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
    await mkdtemp(path.join(tmpdir(), 'limina-paths-')),
  );

  for (const [relativePath, text] of Object.entries(files)) {
    await writeText(path.join(rootDir, relativePath), text);
  }

  return {
    cleanup: async () => {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    },
    config: {
      config: {
        checkers: {
          typescript: {
            preset: 'tsc',
            entry: 'tsconfig.build.json',
          },
        },
      },
      configPath: path.join(rootDir, 'limina.config.mjs'),
      rootDir,
    },
    rootDir,
  };
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const buildCompilerOptions = {
  composite: true,
  declaration: true,
  emitDeclarationOnly: true,
  incremental: true,
  module: 'ESNext',
  moduleResolution: 'bundler',
  noEmit: false,
  outDir: './.tsbuild',
  strict: true,
  target: 'ES2023',
  types: [],
};

function createWorkspaceExportFixture(): Record<string, string> {
  return {
    'packages/a/package.json': stringifyConfig({
      dependencies: {
        '@example/b': 'workspace:*',
      },
      name: '@example/a',
      type: 'module',
    }),
    'packages/a/src/index.ts':
      "import { value } from '@example/b';\nimport { feature } from '@example/b/features/foo';\nexport const result = value + feature;\n",
    'packages/a/tsconfig.lib.json': stringifyConfig({
      compilerOptions: {
        ...buildCompilerOptions,
        noEmit: true,
      },
      include: ['src/**/*.ts'],
    }),
    'packages/a/tsconfig.lib.dts.json': stringifyConfig({
      compilerOptions: {
        ...buildCompilerOptions,
        rootDir: 'src',
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      },
      include: ['src/**/*.ts'],
      references: [
        {
          path: '../b/tsconfig.lib.dts.json',
        },
      ],
    }),
    'packages/b/dist/features/foo.d.ts':
      'export declare const feature: number;\n',
    'packages/b/dist/features/foo.js': 'export const feature = 1;\n',
    'packages/b/dist/index.d.ts': 'export declare const value: number;\n',
    'packages/b/dist/index.js': 'export const value = 1;\n',
    'packages/b/package.json': stringifyConfig({
      exports: {
        '.': './dist/index.js',
        './features/*': './dist/features/*.js',
      },
      name: '@example/b',
      type: 'module',
    }),
    'packages/b/src/features/foo.ts': 'export const feature = 1;\n',
    'packages/b/src/index.ts': 'export const value = 1;\n',
    'packages/b/tsconfig.lib.json': stringifyConfig({
      compilerOptions: {
        ...buildCompilerOptions,
        noEmit: true,
      },
      include: ['src/**/*.ts'],
    }),
    'packages/b/tsconfig.lib.dts.json': stringifyConfig({
      compilerOptions: {
        ...buildCompilerOptions,
        rootDir: 'src',
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      },
      include: ['src/**/*.ts'],
    }),
    'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
    'tsconfig.build.json': stringifyConfig({
      files: [],
      references: [
        {
          path: './packages/b/tsconfig.lib.dts.json',
        },
        {
          path: './packages/a/tsconfig.lib.dts.json',
        },
      ],
    }),
  };
}

describe('runPaths', () => {
  it('fails when the shared checker entry has config problems', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        type: 'module',
      }),
      'packages/a/src/index.ts': 'export const value = 1;\n',
      'packages/a/tsconfig.lib.json': stringifyConfig({
        compilerOptions: {
          ...buildCompilerOptions,
          noEmit: true,
        },
        include: ['src/**/*.ts'],
      }),
      'packages/a/tsconfig.lib.dts.json': stringifyConfig({
        compilerOptions: {
          ...buildCompilerOptions,
          rootDir: 'src',
          tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
        },
        include: ['src/**/*.ts'],
      }),
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './packages/a/tsconfig.lib.dts.json',
          },
          {
            path: './packages/missing/tsconfig.build.jsonx',
          },
        ],
      }),
    });

    try {
      await expect(runPaths(fixture.config)).rejects.toThrow(
        /Checker entry references a missing tsconfig/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses the shared graph root config', async () => {
    const fixture = await createFixture({
      ...createWorkspaceExportFixture(),
      'tsconfig.custom.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './packages/b/tsconfig.lib.dts.json',
          },
          {
            path: './packages/a/tsconfig.lib.dts.json',
          },
        ],
      }),
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [],
      }),
    });

    try {
      await expect(
        runGraphCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              typescript: {
                preset: 'tsc',
                entry: 'tsconfig.custom.build.json',
              },
            },
          },
        }),
      ).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('generates source paths for referenced workspace deps whose exports point to dist', async () => {
    const fixture = await createFixture(createWorkspaceExportFixture());
    const generatedPath = path.join(
      fixture.rootDir,
      'packages/a/tsconfig.dts.paths.generated.json',
    );
    const aBuildConfigPath = path.join(
      fixture.rootDir,
      'packages/a/tsconfig.lib.dts.json',
    );

    try {
      await mkdir(
        path.join(fixture.rootDir, 'packages/a/node_modules/@example'),
        {
          recursive: true,
        },
      );
      await symlink(
        '../../../b',
        path.join(fixture.rootDir, 'packages/a/node_modules/@example/b'),
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);

      await expect(runPaths(fixture.config)).resolves.toMatchObject({
        aliasCount: 2,
        outputCount: 1,
        suggestionCount: 1,
      });

      await expect(readFile(generatedPath, 'utf8')).resolves.toContain(
        '"$schema": "../../node_modules/limina/schemas/tsconfig-schema.json"',
      );
      await expect(readFile(generatedPath, 'utf8')).resolves.toContain(
        '"@example/b": ["../b/src/index.ts"]',
      );
      await expect(readFile(generatedPath, 'utf8')).resolves.toContain(
        '"@example/b/features/*": ["../b/src/features/*.ts"]',
      );
      await expect(readFile(aBuildConfigPath, 'utf8')).resolves.not.toContain(
        'tsconfig.dts.paths.generated.json',
      );
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);

      await writeText(
        aBuildConfigPath,
        stringifyConfig({
          extends: ['./tsconfig.dts.paths.generated.json'],
          compilerOptions: {
            ...buildCompilerOptions,
            rootDir: 'src',
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
          },
          include: ['src/**/*.ts'],
          references: [
            {
              path: '../b/tsconfig.lib.dts.json',
            },
          ],
        }),
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('runGraphCheck workspace references', () => {
  it('rejects cross-package build references without workspace protocol dependencies', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': stringifyConfig({
        dependencies: {
          '@example/b': 'link:../b/dist',
        },
        name: '@example/a',
        type: 'module',
      }),
      'packages/a/src/index.ts':
        "import { value } from '@example/b';\nexport const result = value;\n",
      'packages/a/tsconfig.lib.json': stringifyConfig({
        compilerOptions: {
          ...buildCompilerOptions,
          noEmit: true,
        },
        include: ['src/**/*.ts'],
      }),
      'packages/a/tsconfig.lib.dts.json': stringifyConfig({
        compilerOptions: {
          ...buildCompilerOptions,
          rootDir: 'src',
          tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
        },
        include: ['src/**/*.ts'],
        references: [
          {
            path: '../b/tsconfig.lib.dts.json',
          },
        ],
      }),
      'packages/b/package.json': stringifyConfig({
        exports: {
          '.': './src/index.ts',
        },
        name: '@example/b',
        type: 'module',
      }),
      'packages/b/src/index.ts': 'export const value = 1;\n',
      'packages/b/tsconfig.lib.json': stringifyConfig({
        compilerOptions: {
          ...buildCompilerOptions,
          noEmit: true,
        },
        include: ['src/**/*.ts'],
      }),
      'packages/b/tsconfig.lib.dts.json': stringifyConfig({
        compilerOptions: {
          ...buildCompilerOptions,
          rootDir: 'src',
          tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
        },
        include: ['src/**/*.ts'],
      }),
      'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './packages/b/tsconfig.lib.dts.json',
          },
          {
            path: './packages/a/tsconfig.lib.dts.json',
          },
        ],
      }),
    });

    try {
      await mkdir(
        path.join(fixture.rootDir, 'packages/a/node_modules/@example'),
        {
          recursive: true,
        },
      );
      await symlink(
        '../../../b',
        path.join(fixture.rootDir, 'packages/a/node_modules/@example/b'),
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});
