import type { ResolvedLiminaConfig } from '#config/runner';
import { execFile } from 'node:child_process';
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
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createLiminaCli } from '../cli';
import { runMigration } from '../commands/migration';

const execFileAsync = promisify(execFile);
const nestedPackageSchemaPath =
  '../../node_modules/limina/schemas/tsconfig-schema.json';
const rootSchemaPath = './node_modules/limina/schemas/tsconfig-schema.json';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-migration-')),
  );
  const fixtureFiles = {
    'package.json': json({
      name: 'root',
      private: true,
      type: 'module',
    }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    ...files,
  };

  for (const [relativePath, text] of Object.entries(fixtureFiles)) {
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

async function commitFixture(rootDir: string): Promise<void> {
  await execFileAsync('git', ['init'], {
    cwd: rootDir,
  });
  await execFileAsync('git', ['add', '.'], {
    cwd: rootDir,
  });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Limina Test',
      '-c',
      'user.email=limina@example.com',
      'commit',
      '--no-gpg-sign',
      '-m',
      'initial',
    ],
    {
      cwd: rootDir,
    },
  );
}

function createResolvedConfig(
  rootDir: string,
  config: NonNullable<ResolvedLiminaConfig['config']>,
): ResolvedLiminaConfig {
  return {
    config,
    configPath: path.join(rootDir, 'limina.config.mjs'),
    rootDir,
  };
}

describe('runMigration', () => {
  it('fails before writing when the workspace is not a git repository', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          outDir: './dist',
          rootDir: './src',
          target: 'ES2023',
        },
        include: ['src/**/*.ts'],
      }),
    });
    const config = createResolvedConfig(fixture.rootDir, {
      checkers: {
        typescript: {
          include: ['packages/pkg/tsconfig.json'],
          preset: 'tsc',
        },
      },
    });
    const tsconfigPath = path.join(
      fixture.rootDir,
      'packages/pkg/tsconfig.json',
    );
    const before = await readFile(tsconfigPath, 'utf8');

    try {
      await expect(runMigration(config)).rejects.toThrow(
        /Unable to verify the git working tree/u,
      );
      await expect(readFile(tsconfigPath, 'utf8')).resolves.toBe(before);
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails before writing when the git workspace is dirty', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          outDir: './dist',
          rootDir: './src',
          target: 'ES2023',
        },
        include: ['src/**/*.ts'],
      }),
    });
    const config = createResolvedConfig(fixture.rootDir, {
      checkers: {
        typescript: {
          include: ['packages/pkg/tsconfig.json'],
          preset: 'tsc',
        },
      },
    });
    const tsconfigPath = path.join(
      fixture.rootDir,
      'packages/pkg/tsconfig.json',
    );
    const before = await readFile(tsconfigPath, 'utf8');

    try {
      await commitFixture(fixture.rootDir);
      await writeText(path.join(fixture.rootDir, 'dirty.txt'), 'dirty\n');

      await expect(runMigration(config)).rejects.toThrow(
        /requires a clean git working tree/u,
      );
      await expect(readFile(tsconfigPath, 'utf8')).resolves.toBe(before);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports a root-cause blocker when discovery finds no entries', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
    });
    const config = createResolvedConfig(fixture.rootDir, {
      checkers: {
        mode: 'auto',
      },
    });

    try {
      await commitFixture(fixture.rootDir);

      await expect(runMigration(config)).rejects.toThrow(
        /found no tsconfig\.json entries to migrate/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes the schema path relative to a root tsconfig.json', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': json({
        compilerOptions: {
          outDir: './dist',
          rootDir: './src',
          target: 'ES2023',
        },
        include: ['src/**/*.ts'],
      }),
    });
    const config = createResolvedConfig(fixture.rootDir, {
      checkers: {
        typescript: {
          include: ['tsconfig.json'],
          preset: 'tsc',
        },
      },
    });

    try {
      await commitFixture(fixture.rootDir);

      const result = await runMigration(config);
      const migrated = await readJson<{
        $schema?: string;
        liminaOptions?: {
          outputs?: Record<string, unknown>;
        };
      }>(path.join(fixture.rootDir, 'tsconfig.json'));

      expect(result.checkerEntryCount).toBe(1);
      expect(result.modifiedFiles).toHaveLength(1);
      expect(migrated.$schema).toBe(rootSchemaPath);
      expect(migrated.liminaOptions?.outputs).toEqual({
        outDir: './dist',
        rootDir: './src',
        target: 'ES2023',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('migrates explicit checker entries and pure aggregator references', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/src/index.test.ts': 'export const testValue = 1;\n',
      'packages/app/tsconfig.json': json({
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
      'packages/app/tsconfig.lib.json': json({
        compilerOptions: {
          composite: true,
          declaration: true,
          declarationMap: true,
          emitDeclarationOnly: true,
          incremental: true,
          noEmit: false,
          outDir: './dist',
          rootDir: './src',
          strict: true,
          target: 'ES2022',
          tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
        },
        include: ['src/**/*.ts'],
        liminaOptions: {
          graphRules: ['app'],
          implicitRefs: [
            {
              path: './src/generated.ts',
              reason: 'generated',
            },
          ],
          outputs: {
            target: 'ES2019',
          },
        },
        references: [
          {
            path: '../shared',
          },
        ],
      }),
      'packages/app/tsconfig.test.json': json({
        compilerOptions: {
          composite: true,
          outDir: './test-dist',
          rootDir: './src',
          target: 'ES2020',
          types: ['vitest'],
        },
        include: ['src/**/*.test.ts'],
      }),
      'packages/ignored/src/index.ts': 'export const ignored = 1;\n',
      'packages/ignored/tsconfig.json': json({
        compilerOptions: {
          outDir: './dist',
        },
        include: ['src/**/*.ts'],
      }),
    });
    const config = createResolvedConfig(fixture.rootDir, {
      checkers: {
        typescript: {
          exclude: ['packages/ignored/**'],
          include: ['packages/*/tsconfig.json'],
          preset: 'tsc',
        },
      },
    });

    try {
      await commitFixture(fixture.rootDir);

      const result = await runMigration(config);
      const solution = await readJson<Record<string, unknown>>(
        path.join(fixture.rootDir, 'packages/app/tsconfig.json'),
      );
      const lib = await readJson<{
        compilerOptions?: Record<string, unknown>;
        liminaOptions?: {
          graphRules?: string[];
          implicitRefs?: unknown[];
          outputs?: Record<string, unknown>;
        };
        references?: unknown;
      }>(path.join(fixture.rootDir, 'packages/app/tsconfig.lib.json'));
      const test = await readJson<{
        compilerOptions?: Record<string, unknown>;
        liminaOptions?: {
          outputs?: Record<string, unknown>;
        };
      }>(path.join(fixture.rootDir, 'packages/app/tsconfig.test.json'));
      const ignored = await readJson<Record<string, unknown>>(
        path.join(fixture.rootDir, 'packages/ignored/tsconfig.json'),
      );

      expect(result.checkerEntryCount).toBe(1);
      expect(result.recursiveReferenceCount).toBe(2);
      expect(result.modifiedFiles).toHaveLength(3);
      expect(result.skippedFiles).toHaveLength(0);
      expect(solution).toMatchObject({
        $schema: nestedPackageSchemaPath,
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
          {
            path: './tsconfig.test.json',
          },
        ],
      });
      expect(solution).not.toHaveProperty('compilerOptions');
      expect(solution).not.toHaveProperty('liminaOptions.outputs');
      expect(lib.compilerOptions).toEqual({
        strict: true,
      });
      expect(lib.references).toBeUndefined();
      expect(lib.liminaOptions?.graphRules).toEqual(['app']);
      expect(lib.liminaOptions?.implicitRefs).toEqual([
        {
          path: './src/generated.ts',
          reason: 'generated',
        },
      ]);
      expect(lib).toHaveProperty('$schema', nestedPackageSchemaPath);
      expect(lib.liminaOptions?.outputs).toEqual({
        declarationMap: true,
        outDir: './dist',
        rootDir: './src',
        target: 'ES2022',
      });
      expect(test.compilerOptions).toEqual({
        types: ['vitest'],
      });
      expect(test).toHaveProperty('$schema', nestedPackageSchemaPath);
      expect(test.liminaOptions?.outputs).toEqual({
        outDir: './test-dist',
        rootDir: './src',
        target: 'ES2020',
      });
      expect(ignored).not.toHaveProperty('$schema');
    } finally {
      await fixture.cleanup();
    }
  });

  it('migrates source tsconfig.json files that still declare tsc -b references', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': json({
        compilerOptions: {
          composite: true,
          declaration: true,
          declarationMap: true,
          emitDeclarationOnly: true,
          incremental: true,
          noEmit: false,
          outDir: './lib',
          rootDir: './src',
          strict: true,
          target: 'ES2022',
          tsBuildInfoFile: './.tsbuild/app.tsbuildinfo',
        },
        include: ['src/**/*.ts'],
        references: [
          {
            path: '../dep',
          },
        ],
      }),
      'packages/dep/src/index.ts': 'export const dep = 1;\n',
      'packages/dep/tsconfig.json': json({
        compilerOptions: {
          outDir: './lib',
          rootDir: './src',
          target: 'ES2022',
        },
        include: ['src/**/*.ts'],
      }),
    });
    const config = createResolvedConfig(fixture.rootDir, {
      checkers: {
        typescript: {
          include: ['packages/app/tsconfig.json'],
          preset: 'tsc',
        },
      },
    });

    try {
      await commitFixture(fixture.rootDir);

      const result = await runMigration(config);
      const app = await readJson<{
        compilerOptions?: Record<string, unknown>;
        liminaOptions?: {
          outputs?: Record<string, unknown>;
        };
        references?: unknown;
      }>(path.join(fixture.rootDir, 'packages/app/tsconfig.json'));
      const dep = await readJson<Record<string, unknown>>(
        path.join(fixture.rootDir, 'packages/dep/tsconfig.json'),
      );

      expect(result.checkerEntryCount).toBe(1);
      expect(result.recursiveReferenceCount).toBe(0);
      expect(result.modifiedFiles).toHaveLength(1);
      expect(app.references).toBeUndefined();
      expect(app.compilerOptions).toEqual({
        strict: true,
      });
      expect(app.liminaOptions?.outputs).toEqual({
        declarationMap: true,
        outDir: './lib',
        rootDir: './src',
        target: 'ES2022',
      });
      expect(dep).not.toHaveProperty('$schema');
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses auto checker discovery without migrating excluded entries', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          outDir: './dist',
          rootDir: './src',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/skip/src/index.ts': 'export const value = 1;\n',
      'packages/skip/tsconfig.json': json({
        compilerOptions: {
          outDir: './dist',
        },
        include: ['src/**/*.ts'],
      }),
    });
    const config = createResolvedConfig(fixture.rootDir, {
      checkers: {
        exclude: ['packages/skip/**'],
        mode: 'auto',
      },
    });

    try {
      await commitFixture(fixture.rootDir);

      const result = await runMigration(config);
      const migrated = await readJson<Record<string, unknown>>(
        path.join(fixture.rootDir, 'packages/pkg/tsconfig.json'),
      );
      const skipped = await readJson<Record<string, unknown>>(
        path.join(fixture.rootDir, 'packages/skip/tsconfig.json'),
      );

      expect(result.checkerEntryCount).toBe(1);
      expect(result.modifiedFiles).toHaveLength(1);
      expect(migrated).toHaveProperty('$schema', nestedPackageSchemaPath);
      expect(skipped).not.toHaveProperty('$schema');
    } finally {
      await fixture.cleanup();
    }
  });

  it('tells users to run init before migration when no Limina config exists', async () => {
    const fixture = await createFixture({});
    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;

    try {
      process.chdir(fixture.rootDir);
      const cli = createLiminaCli();

      cli.parse(['node', 'limina', 'migration'], {
        run: false,
      });

      await expect(cli.runMatchedCommand()).rejects.toThrow(
        'Run npx limina init first, then rerun npx limina migration.',
      );
    } finally {
      process.chdir(previousCwd);
      process.exitCode = previousExitCode;
      await fixture.cleanup();
    }
  });
});
