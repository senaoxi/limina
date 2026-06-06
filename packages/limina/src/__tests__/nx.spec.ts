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
import { runNx } from '../commands/nx';
import type { ResolvedLiminaConfig } from '../config';

const defaultCheckers: NonNullable<ResolvedLiminaConfig['config']>['checkers'] =
  {
    typescript: {
      preset: 'tsc',
      entry: 'tsconfig.build.json',
    },
  };
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

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function createFixture(
  files: Record<string, string>,
  config: Partial<ResolvedLiminaConfig> = {},
): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-nx-')),
  );

  await writeText(
    path.join(rootDir, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n',
  );
  await writeText(
    path.join(rootDir, 'package.json'),
    stringifyConfig({
      name: 'root',
      private: true,
    }),
  );
  await writeText(path.join(rootDir, 'nx.json'), '{}\n');

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
      ...config,
      configPath: path.join(rootDir, 'limina.config.mjs'),
      rootDir,
    },
    rootDir,
  };
}

function createPackageJson(
  name: string,
  options: {
    build?: boolean;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    exports?: unknown;
  } = {},
): string {
  return stringifyConfig({
    name,
    scripts: options.build
      ? {
          build: 'echo build',
        }
      : undefined,
    dependencies: options.dependencies,
    devDependencies: options.devDependencies,
    exports: options.exports,
  });
}

function rootBuildConfig(references: string[]): string {
  return stringifyConfig({
    references: references.map((reference) => ({
      path: reference,
    })),
  });
}

function dtsBuildConfig(include: string[]): string {
  return stringifyConfig({
    compilerOptions: {
      ...buildCompilerOptions,
      rootDir: '.',
      tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
    },
    include,
  });
}

function typecheckBuildConfig(
  include: string[],
  compilerOptions: Record<string, unknown> = {},
): string {
  return stringifyConfig({
    compilerOptions: {
      ...buildCompilerOptions,
      noEmit: true,
      ...compilerOptions,
    },
    include,
  });
}

function checkerFixtureConfig(): Partial<ResolvedLiminaConfig> {
  return {
    config: {
      checkers: defaultCheckers,
    },
  };
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('runNx', () => {
  it('syncs build dependsOn only for link artifact dependencies by default', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        build: true,
        dependencies: {
          '@example/b': 'workspace:*',
          '@example/c': 'link:../c/dist',
        },
      }),
      'packages/b/package.json': createPackageJson('@example/b', {
        build: true,
      }),
      'packages/c/package.json': createPackageJson('@example/c', {
        build: true,
      }),
    });
    const aProjectJsonPath = path.join(
      fixture.rootDir,
      'packages/a/project.json',
    );

    try {
      await expect(runNx(fixture.config)).resolves.toMatchObject({
        changed: true,
        edgeCount: 1,
        outputCount: 3,
      });

      await expect(runNx(fixture.config, { check: true })).resolves.toEqual({
        changed: false,
        edgeCount: 1,
        outputCount: 3,
      });

      const projectJson = await readJson(aProjectJsonPath);

      expect(projectJson).toMatchObject({
        name: '@example/a',
        targets: {
          build: {
            dependsOn: [
              {
                projects: ['@example/c'],
                target: 'build',
              },
            ],
          },
        },
        metadata: {
          limina: {
            generated: true,
          },
        },
      });

      await expect(
        readJson(path.join(fixture.rootDir, 'packages/b/project.json')),
      ).resolves.toMatchObject({
        targets: {
          build: {
            dependsOn: [],
          },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('syncs dependsOn for workspace imports that resolve to artifact exports', async () => {
    const fixture = await createFixture(
      {
        'tsconfig.build.json': rootBuildConfig([
          './packages/b/tsconfig.lib.dts.json',
          './packages/a/tsconfig.lib.dts.json',
        ]),
        'packages/a/package.json': createPackageJson('@example/a', {
          build: true,
          dependencies: {
            '@example/b': 'workspace:*',
          },
        }),
        'packages/a/src/index.ts':
          "import { runtimeValue } from '@example/b/runtime';\nexport const value = runtimeValue;\n",
        'packages/a/tsconfig.lib.dts.json': dtsBuildConfig(['src/**/*.ts']),
        'packages/a/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
        'packages/b/package.json': createPackageJson('@example/b', {
          build: true,
          exports: {
            '.': './src/index.ts',
            './runtime': {
              types: './dist/runtime.d.ts',
              default: './dist/runtime.js',
            },
          },
        }),
        'packages/b/src/index.ts': 'export const sourceValue = 1;\n',
        'packages/b/dist/runtime.d.ts':
          'export declare const runtimeValue = 1;\n',
        'packages/b/dist/runtime.js': 'export const runtimeValue = 1;\n',
        'packages/b/tsconfig.lib.dts.json': dtsBuildConfig(['src/**/*.ts']),
        'packages/b/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
      },
      checkerFixtureConfig(),
    );
    const aProjectJsonPath = path.join(
      fixture.rootDir,
      'packages/a/project.json',
    );

    try {
      await expect(runNx(fixture.config, { check: true })).resolves.toEqual({
        changed: true,
        edgeCount: 1,
        outputCount: 2,
      });
      await expect(readFile(aProjectJsonPath, 'utf8')).rejects.toThrow(
        /ENOENT/u,
      );

      await expect(runNx(fixture.config)).resolves.toEqual({
        changed: true,
        edgeCount: 1,
        outputCount: 2,
      });

      const projectJson = await readJson(aProjectJsonPath);

      expect(projectJson).toMatchObject({
        targets: {
          build: {
            dependsOn: [
              {
                projects: ['@example/b'],
                target: 'build',
              },
            ],
          },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not add dependsOn for workspace imports that resolve to source exports', async () => {
    const fixture = await createFixture(
      {
        'tsconfig.build.json': rootBuildConfig([
          './packages/b/tsconfig.lib.dts.json',
          './packages/a/tsconfig.lib.dts.json',
        ]),
        'packages/a/package.json': createPackageJson('@example/a', {
          build: true,
          dependencies: {
            '@example/b': 'workspace:*',
          },
        }),
        'packages/a/src/index.ts':
          "import { sourceValue } from '@example/b';\nexport const value = sourceValue;\n",
        'packages/a/tsconfig.lib.dts.json': dtsBuildConfig(['src/**/*.ts']),
        'packages/a/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
        'packages/b/package.json': createPackageJson('@example/b', {
          build: true,
          exports: {
            '.': './src/index.ts',
            './runtime': {
              types: './dist/runtime.d.ts',
              default: './dist/runtime.js',
            },
          },
        }),
        'packages/b/src/index.ts': 'export const sourceValue = 1;\n',
        'packages/b/dist/runtime.d.ts':
          'export declare const runtimeValue = 1;\n',
        'packages/b/dist/runtime.js': 'export const runtimeValue = 1;\n',
        'packages/b/tsconfig.lib.dts.json': dtsBuildConfig(['src/**/*.ts']),
        'packages/b/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
      },
      checkerFixtureConfig(),
    );

    try {
      await expect(runNx(fixture.config)).resolves.toEqual({
        changed: true,
        edgeCount: 0,
        outputCount: 2,
      });

      await expect(
        readJson(path.join(fixture.rootDir, 'packages/a/project.json')),
      ).resolves.toMatchObject({
        targets: {
          build: {
            dependsOn: [],
          },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses typecheck companion paths when classifying workspace exports', async () => {
    const fixture = await createFixture(
      {
        'tsconfig.build.json': rootBuildConfig([
          './packages/b/tsconfig.lib.dts.json',
          './packages/a/tsconfig.lib.dts.json',
        ]),
        'packages/a/package.json': createPackageJson('@example/a', {
          build: true,
          dependencies: {
            '@example/b': 'workspace:*',
          },
        }),
        'packages/a/src/index.ts':
          "import { sourceValue } from '@example/b';\nexport const value = sourceValue;\n",
        'packages/a/tsconfig.lib.dts.json': dtsBuildConfig(['src/**/*.ts']),
        'packages/a/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts'], {
          baseUrl: '.',
          paths: {
            '@example/b': ['../b/src/index.ts'],
          },
        }),
        'packages/b/package.json': createPackageJson('@example/b', {
          build: true,
          exports: {
            '.': {
              default: './dist/index.js',
              types: './dist/index.d.ts',
            },
          },
        }),
        'packages/b/src/index.ts': 'export const sourceValue = 1;\n',
        'packages/b/dist/index.d.ts': 'export declare const sourceValue = 1;\n',
        'packages/b/dist/index.js': 'export const sourceValue = 1;\n',
        'packages/b/tsconfig.lib.dts.json': dtsBuildConfig(['src/**/*.ts']),
        'packages/b/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
      },
      checkerFixtureConfig(),
    );

    try {
      await expect(runNx(fixture.config)).resolves.toEqual({
        changed: true,
        edgeCount: 0,
        outputCount: 2,
      });

      await expect(
        readJson(path.join(fixture.rootDir, 'packages/a/project.json')),
      ).resolves.toMatchObject({
        targets: {
          build: {
            dependsOn: [],
          },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not add dependsOn for unused workspace artifact exports', async () => {
    const fixture = await createFixture(
      {
        'tsconfig.build.json': rootBuildConfig([
          './packages/b/tsconfig.lib.dts.json',
          './packages/a/tsconfig.lib.dts.json',
        ]),
        'packages/a/package.json': createPackageJson('@example/a', {
          build: true,
          dependencies: {
            '@example/b': 'workspace:*',
          },
        }),
        'packages/a/src/index.ts': 'export const value = 1;\n',
        'packages/a/tsconfig.lib.dts.json': dtsBuildConfig(['src/**/*.ts']),
        'packages/b/package.json': createPackageJson('@example/b', {
          build: true,
          exports: {
            './runtime': {
              types: './dist/runtime.d.ts',
              default: './dist/runtime.js',
            },
          },
        }),
        'packages/b/src/index.ts': 'export const sourceValue = 1;\n',
        'packages/b/dist/runtime.d.ts':
          'export declare const runtimeValue = 1;\n',
        'packages/b/dist/runtime.js': 'export const runtimeValue = 1;\n',
        'packages/b/tsconfig.lib.dts.json': dtsBuildConfig(['src/**/*.ts']),
      },
      checkerFixtureConfig(),
    );

    try {
      await expect(runNx(fixture.config)).resolves.toEqual({
        changed: true,
        edgeCount: 0,
        outputCount: 2,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('syncs dependsOn for type-only workspace exports that resolve to dist declarations', async () => {
    const fixture = await createFixture(
      {
        'tsconfig.build.json': rootBuildConfig([
          './packages/b/tsconfig.lib.dts.json',
          './packages/a/tsconfig.lib.dts.json',
        ]),
        'packages/a/package.json': createPackageJson('@example/a', {
          build: true,
          dependencies: {
            '@example/b': 'workspace:*',
          },
        }),
        'packages/a/src/index.ts':
          "import type { RuntimeValue } from '@example/b/types';\nexport type Value = RuntimeValue;\n",
        'packages/a/tsconfig.lib.dts.json': dtsBuildConfig(['src/**/*.ts']),
        'packages/b/package.json': createPackageJson('@example/b', {
          build: true,
          exports: {
            './types': {
              types: './dist/types.d.ts',
            },
          },
        }),
        'packages/b/src/index.ts': 'export const sourceValue = 1;\n',
        'packages/b/dist/types.d.ts':
          'export interface RuntimeValue { ready: true }\n',
        'packages/b/tsconfig.lib.dts.json': dtsBuildConfig(['src/**/*.ts']),
      },
      checkerFixtureConfig(),
    );

    try {
      await expect(runNx(fixture.config)).resolves.toEqual({
        changed: true,
        edgeCount: 1,
        outputCount: 2,
      });

      await expect(
        readJson(path.join(fixture.rootDir, 'packages/a/project.json')),
      ).resolves.toMatchObject({
        targets: {
          build: {
            dependsOn: [
              {
                projects: ['@example/b'],
                target: 'build',
              },
            ],
          },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('syncs multiple targets and removes duplicate target arguments', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        build: true,
        dependencies: {
          '@example/b': 'link:../b/dist',
        },
      }),
      'packages/b/package.json': createPackageJson('@example/b', {
        build: true,
      }),
    });

    try {
      await expect(
        runNx(fixture.config, {
          targets: ['docs:build', 'build', 'docs:build'],
        }),
      ).resolves.toEqual({
        changed: true,
        edgeCount: 2,
        outputCount: 2,
      });

      const projectJson = await readJson(
        path.join(fixture.rootDir, 'packages/a/project.json'),
      );

      expect(projectJson).toMatchObject({
        targets: {
          build: {
            dependsOn: [
              {
                projects: ['@example/b'],
                target: 'build',
              },
            ],
          },
          'docs:build': {
            dependsOn: [
              {
                projects: ['@example/b'],
                target: 'build',
              },
            ],
          },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('overwrites existing target dependsOn while preserving manual project fields', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        build: true,
        dependencies: {
          '@example/b': 'link:../b/dist',
        },
      }),
      'packages/a/project.json': stringifyConfig({
        name: '@example/a',
        targets: {
          build: {
            command: 'pnpm build',
            dependsOn: [
              {
                projects: ['@example/old'],
                target: 'build',
              },
            ],
          },
          test: {
            dependsOn: ['^build'],
          },
        },
        tags: ['manual'],
      }),
      'packages/b/package.json': createPackageJson('@example/b', {
        build: true,
      }),
    });

    try {
      await expect(runNx(fixture.config)).resolves.toEqual({
        changed: true,
        edgeCount: 1,
        outputCount: 2,
      });

      const projectJson = await readJson(
        path.join(fixture.rootDir, 'packages/a/project.json'),
      );

      expect(projectJson).toMatchObject({
        targets: {
          build: {
            command: 'pnpm build',
            dependsOn: [
              {
                projects: ['@example/b'],
                target: 'build',
              },
            ],
          },
          test: {
            dependsOn: ['^build'],
          },
        },
        tags: ['manual'],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('skips existing project configs that do not define the requested target', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        build: true,
        dependencies: {
          '@example/b': 'link:../b/dist',
        },
      }),
      'packages/a/project.json': stringifyConfig({
        name: '@example/a',
        targets: {
          test: {
            dependsOn: ['^build'],
          },
        },
      }),
      'packages/b/package.json': createPackageJson('@example/b', {
        build: true,
      }),
    });
    const aProjectJsonPath = path.join(
      fixture.rootDir,
      'packages/a/project.json',
    );
    const originalContent = await readFile(aProjectJsonPath, 'utf8');

    try {
      await expect(
        runNx(fixture.config, { targets: ['docs:build'] }),
      ).resolves.toEqual({
        changed: true,
        edgeCount: 1,
        outputCount: 2,
      });

      expect(await readFile(aProjectJsonPath, 'utf8')).toBe(originalContent);
      await expect(
        readJson(path.join(fixture.rootDir, 'packages/b/project.json')),
      ).resolves.toMatchObject({
        targets: {
          'docs:build': {
            dependsOn: [],
          },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports stale missing project configs in check mode without writing files', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        build: true,
        dependencies: {
          '@example/b': 'link:../b/dist',
        },
      }),
      'packages/b/package.json': createPackageJson('@example/b', {
        build: true,
      }),
    });

    try {
      await expect(runNx(fixture.config, { check: true })).resolves.toEqual({
        changed: true,
        edgeCount: 1,
        outputCount: 2,
      });
      await expect(
        readFile(path.join(fixture.rootDir, 'packages/a/project.json'), 'utf8'),
      ).rejects.toThrow(/ENOENT/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it('filters the root package when rootDir uses an equivalent path spelling', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        build: true,
        dependencies: {
          '@example/b': 'link:../b/dist',
        },
      }),
      'packages/a/project.json': stringifyConfig({
        name: '@example/a',
        targets: {
          build: {
            dependsOn: [
              {
                projects: ['@example/b'],
                target: 'build',
              },
            ],
          },
        },
      }),
      'packages/b/package.json': createPackageJson('@example/b', {
        build: true,
      }),
      'packages/b/project.json': stringifyConfig({
        name: '@example/b',
        targets: {
          build: {
            dependsOn: [],
          },
        },
      }),
    });

    fixture.config.rootDir = `${fixture.rootDir}${path.sep}`;

    try {
      await expect(runNx(fixture.config, { check: true })).resolves.toEqual({
        changed: false,
        edgeCount: 1,
        outputCount: 2,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('checks dependsOn project sets without requiring the same order', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        build: true,
        dependencies: {
          '@example/b': 'link:../b/dist',
          '@example/c': 'link:../c/dist',
        },
      }),
      'packages/a/project.json': stringifyConfig({
        name: '@example/a',
        targets: {
          build: {
            dependsOn: [
              {
                projects: ['@example/c', '@example/b', '@example/b'],
                target: 'build',
              },
            ],
          },
        },
      }),
      'packages/b/package.json': createPackageJson('@example/b', {
        build: true,
      }),
      'packages/b/project.json': stringifyConfig({
        name: '@example/b',
        targets: {
          build: {
            dependsOn: [],
          },
        },
      }),
      'packages/c/package.json': createPackageJson('@example/c', {
        build: true,
      }),
      'packages/c/project.json': stringifyConfig({
        name: '@example/c',
        targets: {
          build: {
            dependsOn: [],
          },
        },
      }),
    });

    try {
      await expect(runNx(fixture.config, { check: true })).resolves.toEqual({
        changed: false,
        edgeCount: 2,
        outputCount: 3,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('treats non-object target configs as stale in check mode', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        build: true,
      }),
      'packages/a/project.json': stringifyConfig({
        name: '@example/a',
        targets: {
          build: 'pnpm build',
        },
      }),
    });

    try {
      await expect(runNx(fixture.config, { check: true })).resolves.toEqual({
        changed: true,
        edgeCount: 0,
        outputCount: 1,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects non-dist link targets as artifact directories by default', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        build: true,
        dependencies: {
          '@example/b': 'link:../b/lib',
        },
      }),
      'packages/b/package.json': createPackageJson('@example/b', {
        build: true,
      }),
    });

    try {
      await expect(runNx(fixture.config)).rejects.toThrow(
        /does not point at an artifact directory/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails when a link dependency does not target an artifact directory', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        build: true,
        dependencies: {
          '@example/b': 'link:../b/src',
        },
      }),
      'packages/b/package.json': createPackageJson('@example/b', {
        build: true,
      }),
    });

    try {
      await expect(runNx(fixture.config)).rejects.toThrow(
        /does not point at an artifact directory/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails when a link dependency names an unknown workspace package', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        build: true,
        dependencies: {
          '@example/missing': 'link:../missing/dist',
        },
      }),
    });

    try {
      await expect(runNx(fixture.config)).rejects.toThrow(
        /unknown workspace package/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails when a link dependency target has no build script', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        build: true,
        dependencies: {
          '@example/b': 'link:../b/dist',
        },
      }),
      'packages/b/package.json': createPackageJson('@example/b'),
    });

    try {
      await expect(runNx(fixture.config)).rejects.toThrow(
        /target has no build script/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails when a consumed workspace artifact export target has no build script', async () => {
    const fixture = await createFixture(
      {
        'tsconfig.build.json': rootBuildConfig([
          './packages/b/tsconfig.lib.dts.json',
          './packages/a/tsconfig.lib.dts.json',
        ]),
        'packages/a/package.json': createPackageJson('@example/a', {
          build: true,
          dependencies: {
            '@example/b': 'workspace:*',
          },
        }),
        'packages/a/src/index.ts':
          "import { runtimeValue } from '@example/b/runtime';\nexport const value = runtimeValue;\n",
        'packages/a/tsconfig.lib.dts.json': dtsBuildConfig(['src/**/*.ts']),
        'packages/b/package.json': createPackageJson('@example/b', {
          exports: {
            './runtime': {
              types: './dist/runtime.d.ts',
              default: './dist/runtime.js',
            },
          },
        }),
        'packages/b/src/index.ts': 'export const sourceValue = 1;\n',
        'packages/b/dist/runtime.d.ts':
          'export declare const runtimeValue = 1;\n',
        'packages/b/dist/runtime.js': 'export const runtimeValue = 1;\n',
        'packages/b/tsconfig.lib.dts.json': dtsBuildConfig(['src/**/*.ts']),
      },
      checkerFixtureConfig(),
    );

    try {
      await expect(runNx(fixture.config)).rejects.toThrow(
        /target has no build script/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails on artifact build dependency cycles', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        build: true,
        dependencies: {
          '@example/b': 'link:../b/dist',
        },
      }),
      'packages/b/package.json': createPackageJson('@example/b', {
        build: true,
        dependencies: {
          '@example/a': 'link:../a/dist',
        },
      }),
    });

    try {
      await expect(runNx(fixture.config)).rejects.toThrow(
        /artifact build dependency cycle/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails when workspace export artifact edges participate in cycles with link edges', async () => {
    const fixture = await createFixture(
      {
        'tsconfig.build.json': rootBuildConfig([
          './packages/b/tsconfig.lib.dts.json',
          './packages/a/tsconfig.lib.dts.json',
        ]),
        'packages/a/package.json': createPackageJson('@example/a', {
          build: true,
          dependencies: {
            '@example/b': 'workspace:*',
          },
        }),
        'packages/a/src/index.ts':
          "import { runtimeValue } from '@example/b/runtime';\nexport const value = runtimeValue;\n",
        'packages/a/tsconfig.lib.dts.json': dtsBuildConfig(['src/**/*.ts']),
        'packages/b/package.json': createPackageJson('@example/b', {
          build: true,
          dependencies: {
            '@example/a': 'link:../a/dist',
          },
          exports: {
            './runtime': {
              types: './dist/runtime.d.ts',
              default: './dist/runtime.js',
            },
          },
        }),
        'packages/b/src/index.ts': 'export const sourceValue = 1;\n',
        'packages/b/dist/runtime.d.ts':
          'export declare const runtimeValue = 1;\n',
        'packages/b/dist/runtime.js': 'export const runtimeValue = 1;\n',
        'packages/b/tsconfig.lib.dts.json': dtsBuildConfig(['src/**/*.ts']),
      },
      checkerFixtureConfig(),
    );

    try {
      await expect(runNx(fixture.config)).rejects.toThrow(
        /artifact build dependency cycle/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
