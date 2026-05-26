import {
  access,
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
import { runInit } from '../commands/init';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-init-')),
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
    rootDir,
  };
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const compilerOptions = {
  module: 'ESNext',
  moduleResolution: 'bundler',
  target: 'ES2023',
  types: [],
};

function typecheckConfig(include: string[]): string {
  return stringifyConfig({
    compilerOptions,
    include,
  });
}

function createWorkspaceFixture(): Record<string, string> {
  return {
    'package.json': stringifyConfig({
      name: 'root',
      private: true,
      type: 'module',
    }),
    'packages/bar/bar.ts': 'export const sayHello = () => "hello";\n',
    'packages/bar/package.json': stringifyConfig({
      exports: {
        '.': './bar.ts',
        './package.json': './package.json',
        './tools': './scripts/index.ts',
      },
      name: 'bar',
      type: 'module',
    }),
    'packages/bar/scripts/index.ts':
      'export const doSomething = () => "tools";\n',
    'packages/bar/scripts/tsconfig.tools.json': typecheckConfig(['index.ts']),
    'packages/bar/tsconfig.json': typecheckConfig(['bar.ts']),
    'packages/empty/package.json': stringifyConfig({
      name: 'empty',
      type: 'module',
    }),
    'packages/foo/foo.ts':
      "import { sayHello } from 'bar';\nimport { helper } from './helper';\nimport { internal } from '#internal';\nimport { self } from './self';\nexport const value = `${sayHello()}-${helper}-${internal}-${self}`;\n",
    'packages/foo/helper.ts': 'export const helper = "helper";\n',
    'packages/foo/internal.ts': 'export const internal = "internal";\n',
    'packages/foo/package.json': stringifyConfig({
      dependencies: {
        bar: 'workspace:*',
      },
      imports: {
        '#internal': './internal.ts',
      },
      name: 'foo',
      type: 'module',
    }),
    'packages/foo/tsconfig.helpers.json': typecheckConfig([
      'helper.ts',
      'internal.ts',
    ]),
    'packages/foo/self.ts': 'export const self = "self";\n',
    'packages/foo/tsconfig.lib.json': typecheckConfig(['foo.ts', 'self.ts']),
    'packages/foo2/foo2.ts':
      "import { doSomething } from 'bar/tools';\nexport const value = doSomething();\n",
    'packages/foo2/package.json': stringifyConfig({
      dependencies: {
        bar: 'workspace:*',
      },
      name: 'foo2',
      type: 'module',
    }),
    'packages/foo2/tsconfig.lib.json': typecheckConfig(['foo2.ts']),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  };
}

describe('runInit', () => {
  it('fails when no pnpm workspace root can be found', async () => {
    const fixture = await createFixture({
      'package.json': '{}\n',
    });

    try {
      await expect(
        runInit({
          clearScreen: false,
          cwd: fixture.rootDir,
          yes: true,
        }),
      ).rejects.toThrow(/no pnpm-workspace\.yaml/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails when reserved Limina tsconfig names already exist', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
      }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [],
      }),
    });

    try {
      await expect(
        runInit({
          clearScreen: false,
          cwd: fixture.rootDir,
          yes: true,
        }),
      ).rejects.toThrow(/reserved Limina tsconfig names/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects workspace imports that TypeScript resolves outside generated leaves', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
      }),
      'packages/app/app.ts':
        "import { value } from 'dep';\nexport { value };\n",
      'packages/app/package.json': stringifyConfig({
        dependencies: {
          dep: 'workspace:*',
        },
        name: 'app',
      }),
      'packages/app/tsconfig.json': typecheckConfig(['app.ts']),
      'packages/dep/package.json': stringifyConfig({
        exports: {
          '.': './dist/index.d.ts',
        },
        name: 'dep',
      }),
      'packages/dep/dist/index.d.ts': 'export declare const value: number;\n',
      'packages/dep/src/index.ts': 'export const value = 1;\n',
      'packages/dep/tsconfig.json': typecheckConfig(['src/index.ts']),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      await expect(
        runInit({
          clearScreen: false,
          cwd: fixture.rootDir,
          yes: true,
        }),
      ).rejects.toThrow(/not covered by any ordinary tsconfig/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects tsconfig.json files that mix references and source inputs', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
      }),
      'pnpm-workspace.yaml': 'packages: []\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': stringifyConfig({
        compilerOptions,
        include: ['src/**/*.ts'],
        references: [
          {
            path: './packages/app',
          },
        ],
      }),
    });

    try {
      await expect(
        runInit({
          clearScreen: false,
          cwd: fixture.rootDir,
          yes: true,
        }),
      ).rejects.toThrow(/Invalid tsconfig role/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects scoped tsconfig files used as aggregators', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
      }),
      'pnpm-workspace.yaml': 'packages: []\n',
      'tsconfig.lib.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './tsconfig.json',
          },
        ],
      }),
    });

    try {
      await expect(
        runInit({
          clearScreen: false,
          cwd: fixture.rootDir,
          yes: true,
        }),
      ).rejects.toThrow(/Invalid scoped tsconfig role/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it('creates a root package.json when the workspace root has none', async () => {
    const fixture = await createFixture({
      'pnpm-workspace.yaml': 'packages: []\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': typecheckConfig(['src/**/*.ts']),
    });

    try {
      await runInit({
        clearScreen: false,
        cwd: fixture.rootDir,
        yes: true,
      });

      const rootManifest = await readJson<{
        devDependencies?: Record<string, string>;
        private?: boolean;
        scripts?: Record<string, string>;
        type?: string;
      }>(path.join(fixture.rootDir, 'package.json'));

      expect(rootManifest).toMatchObject({
        private: true,
        scripts: {
          'limina:check': 'limina check',
        },
        type: 'module',
      });
      expect(rootManifest.devDependencies?.limina).toMatch(/^\^/u);
      expect(rootManifest.devDependencies?.typescript).toBe('~5.9.3');
    } finally {
      await fixture.cleanup();
    }
  });

  it('references all root declaration leaves from the root build aggregator', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
        private: true,
        type: 'module',
      }),
      'packages/app/index.ts': 'export const value = 1;\n',
      'packages/app/package.json': stringifyConfig({
        name: 'app',
        type: 'module',
      }),
      'packages/app/tsconfig.json': typecheckConfig(['index.ts']),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'scripts/build.ts': 'export const build = () => undefined;\n',
      'src/index.ts': 'export const root = 1;\n',
      'tsconfig.json': typecheckConfig(['src/**/*.ts']),
      'tsconfig.tools.json': typecheckConfig(['scripts/**/*.ts']),
    });

    try {
      await runInit({
        clearScreen: false,
        cwd: fixture.rootDir,
        yes: true,
      });

      expect(
        await readJson(path.join(fixture.rootDir, 'tsconfig.build.json')),
      ).toEqual({
        $schema: 'https://json.schemastore.org/tsconfig',
        files: [],
        references: [
          {
            path: './packages/app/tsconfig.build.json',
          },
          {
            path: './tsconfig.dts.json',
          },
          {
            path: './tsconfig.tools.dts.json',
          },
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  }, 30000);

  it('generates declaration leaves, build aggregators, config, and root script', async () => {
    const fixture = await createFixture(createWorkspaceFixture());

    try {
      const result = await runInit({
        clearScreen: false,
        cwd: path.join(fixture.rootDir, 'packages/foo'),
        yes: true,
      });

      expect(result.installRequired).toBe(true);
      expect(
        await readJson(
          path.join(fixture.rootDir, 'packages/foo/tsconfig.lib.dts.json'),
        ),
      ).toEqual({
        $schema: 'https://json.schemastore.org/tsconfig',
        extends: ['./tsconfig.lib.json'],
        compilerOptions: {
          composite: true,
          declaration: true,
          declarationMap: false,
          emitDeclarationOnly: true,
          incremental: true,
          noEmit: false,
          outDir: './.limina',
          rootDir: '.',
          tsBuildInfoFile: './.limina/lib.tsbuildinfo',
        },
        references: [
          {
            path: '../bar/tsconfig.dts.json',
          },
          {
            path: './tsconfig.helpers.dts.json',
          },
        ],
      });
      expect(
        await readJson(
          path.join(fixture.rootDir, 'packages/foo2/tsconfig.lib.dts.json'),
        ),
      ).toMatchObject({
        references: [
          {
            path: '../bar/scripts/tsconfig.tools.dts.json',
          },
        ],
      });
      expect(
        await readJson(
          path.join(fixture.rootDir, 'packages/bar/tsconfig.build.json'),
        ),
      ).toEqual({
        $schema: 'https://json.schemastore.org/tsconfig',
        files: [],
        references: [
          {
            path: './scripts/tsconfig.tools.dts.json',
          },
          {
            path: './tsconfig.dts.json',
          },
        ],
      });
      await expect(
        fileExists(
          path.join(fixture.rootDir, 'packages/empty/tsconfig.build.json'),
        ),
      ).resolves.toBe(false);
      expect(
        await readFile(path.join(fixture.rootDir, 'limina.config.mjs'), 'utf8'),
      ).toContain("entry: 'tsconfig.build.json'");

      const rootManifest = await readJson<{
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      }>(path.join(fixture.rootDir, 'package.json'));

      expect(rootManifest.scripts?.['limina:check']).toBe('limina check');
      expect(rootManifest.devDependencies?.limina).toMatch(/^\^/u);
    } finally {
      await fixture.cleanup();
    }
  }, 30000);
});
