import type { ResolvedLiminaConfig } from '#config/runner';
import { parse } from 'jsonc-parser';
import { execFile } from 'node:child_process';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createLiminaCli } from '../cli';
import { runMigration } from '../commands/migration';
import { toPortablePaths } from './helpers/path';

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

async function removeFixtureDirectory(rootDir: string): Promise<void> {
  await rm(rootDir, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 50,
  });
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
    cleanup: () => removeFixtureDirectory(rootDir),
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

async function createMultipleWorktreeFixture(
  options: { externalTsconfig?: string } = {},
): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  externalConfigPath: string;
  externalRootDir: string;
  rootConfigPath: string;
  rootDir: string;
}> {
  const parentDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-migration-worktrees-')),
  );
  const rootDir = path.join(parentDir, 'root');
  const externalRootDir = path.join(parentDir, 'external');
  const rootConfigPath = path.join(rootDir, 'tsconfig.json');
  const externalConfigPath = path.join(externalRootDir, 'tsconfig.json');
  const tsconfig = json({
    compilerOptions: {
      outDir: './dist',
      rootDir: './src',
      target: 'ES2023',
    },
    include: ['src/**/*.ts'],
  });

  await writeText(
    path.join(rootDir, 'package.json'),
    json({ name: '@example/root', private: true, type: 'module' }),
  );
  await writeText(
    path.join(rootDir, 'pnpm-workspace.yaml'),
    'packages:\n  - ../external\n',
  );
  await writeText(
    path.join(rootDir, 'limina.config.mjs'),
    'export default {};\n',
  );
  await writeText(path.join(rootDir, 'src/index.ts'), 'export {};\n');
  await writeText(rootConfigPath, tsconfig);
  await writeText(
    path.join(externalRootDir, 'package.json'),
    json({ name: '@example/external', version: '1.0.0' }),
  );
  await writeText(path.join(externalRootDir, 'src/index.ts'), 'export {};\n');
  await writeText(externalConfigPath, options.externalTsconfig ?? tsconfig);

  await commitFixture(rootDir);
  await commitFixture(externalRootDir);

  return {
    cleanup: () => removeFixtureDirectory(parentDir),
    config: createResolvedConfig(rootDir, {
      checkers: {
        typescript: {
          include: ['tsconfig.json', '../external/tsconfig.json'],
          preset: 'tsc',
        },
      },
    }),
    externalConfigPath,
    externalRootDir,
    rootConfigPath,
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
        /Unable to resolve the Git worktree/u,
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

  it('migrates targets across every involved clean Git worktree', async () => {
    const fixture = await createMultipleWorktreeFixture();

    try {
      const result = await runMigration(fixture.config);

      expect(result.modifiedFiles).toEqual(
        toPortablePaths([fixture.externalConfigPath, fixture.rootConfigPath]),
      );
      await expect(
        readJson<{ liminaOptions?: { outputs?: { outDir?: string } } }>(
          fixture.rootConfigPath,
        ),
      ).resolves.toMatchObject({
        liminaOptions: { outputs: { outDir: './dist' } },
      });
      await expect(
        readJson<{ liminaOptions?: { outputs?: { outDir?: string } } }>(
          fixture.externalConfigPath,
        ),
      ).resolves.toMatchObject({
        liminaOptions: { outputs: { outDir: './dist' } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('checks every involved Git worktree for cleanliness before any write', async () => {
    const fixture = await createMultipleWorktreeFixture();
    const rootBefore = await readFile(fixture.rootConfigPath, 'utf8');
    const externalBefore = await readFile(fixture.externalConfigPath, 'utf8');

    try {
      await writeText(
        path.join(fixture.externalRootDir, 'dirty.txt'),
        'dirty\n',
      );

      await expect(runMigration(fixture.config)).rejects.toThrow(
        /requires a clean git working tree/u,
      );
      await expect(readFile(fixture.rootConfigPath, 'utf8')).resolves.toBe(
        rootBefore,
      );
      await expect(readFile(fixture.externalConfigPath, 'utf8')).resolves.toBe(
        externalBefore,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('plans every worktree before writing when one declarationDir target fails', async () => {
    const fixture = await createMultipleWorktreeFixture({
      externalTsconfig: json({
        compilerOptions: {
          declarationDir: './types',
          outDir: './dist',
          rootDir: './src',
          target: 'ES2023',
        },
        include: ['src/**/*.ts'],
      }),
    });
    const rootBefore = await readFile(fixture.rootConfigPath);
    const externalBefore = await readFile(fixture.externalConfigPath);

    try {
      await expect(runMigration(fixture.config)).rejects.toThrow(
        /one managed artifact output root/u,
      );
      await expect(readFile(fixture.rootConfigPath)).resolves.toEqual(
        rootBefore,
      );
      await expect(readFile(fixture.externalConfigPath)).resolves.toEqual(
        externalBefore,
      );
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

  it('plans every transform before writing any target', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'packages/a/src/index.ts': 'export const a = 1;\n',
      'packages/a/tsconfig.json': json({
        compilerOptions: {
          outDir: './dist',
        },
        include: ['src/**/*.ts'],
      }),
      'packages/z/src/index.ts': 'export const z = 1;\n',
      'packages/z/tsconfig.json': json({
        compilerOptions: [],
        include: ['src/**/*.ts'],
      }),
    });
    const config = createResolvedConfig(fixture.rootDir, {
      checkers: {
        typescript: {
          include: ['packages/*/tsconfig.json'],
          preset: 'tsc',
        },
      },
    });
    const firstPath = path.join(fixture.rootDir, 'packages/a/tsconfig.json');
    const secondPath = path.join(fixture.rootDir, 'packages/z/tsconfig.json');
    const firstBefore = await readFile(firstPath, 'utf8');
    const secondBefore = await readFile(secondPath, 'utf8');

    try {
      await commitFixture(fixture.rootDir);

      await expect(runMigration(config)).rejects.toThrow(
        /compilerOptions[\s\S]*must be an object/u,
      );
      await expect(readFile(firstPath, 'utf8')).resolves.toBe(firstBefore);
      await expect(readFile(secondPath, 'utf8')).resolves.toBe(secondBefore);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects removed root limina metadata before writing a migration target', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': json({
        compilerOptions: {
          outDir: './dist',
        },
        include: ['src/**/*.ts'],
        limina: 'runtime',
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
    const configPath = path.join(fixture.rootDir, 'packages/pkg/tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);
      const before = await readFile(configPath);

      await expect(runMigration(config)).rejects.toThrow(
        [
          'Invalid Limina tsconfig metadata:',
          '  field: limina',
          '  reason: root-level limina metadata is not part of the Limina 0.2.0 tsconfig contract.',
        ].join('\n'),
      );
      await expect(readFile(configPath)).resolves.toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps earlier valid targets unchanged when a later target has removed metadata', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'packages/a/src/index.ts': 'export const value = 1;\n',
      'packages/a/tsconfig.json': json({
        compilerOptions: {
          outDir: './dist',
        },
        include: ['src/**/*.ts'],
      }),
      'packages/z/src/index.ts': 'export const value = 1;\n',
      'packages/z/tsconfig.json': json({
        compilerOptions: {
          outDir: './dist',
        },
        include: ['src/**/*.ts'],
        limina: 'runtime',
      }),
    });
    const config = createResolvedConfig(fixture.rootDir, {
      checkers: {
        typescript: {
          include: ['packages/*/tsconfig.json'],
          preset: 'tsc',
        },
      },
    });
    const firstPath = path.join(fixture.rootDir, 'packages/a/tsconfig.json');
    const laterPath = path.join(fixture.rootDir, 'packages/z/tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);
      const firstBefore = await readFile(firstPath);
      const laterBefore = await readFile(laterPath);

      await expect(runMigration(config)).rejects.toThrow(
        'root-level limina metadata is not part of the Limina 0.2.0 tsconfig contract',
      );
      await expect(readFile(firstPath)).resolves.toEqual(firstBefore);
      await expect(readFile(laterPath)).resolves.toEqual(laterBefore);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses canonical island visibility and skips only the reachable hardlink config', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'storage/tsconfig.json': json({
        $schema: nestedPackageSchemaPath,
        include: ['src/**/*.ts'],
        liminaOptions: {
          outputs: {
            outDir: './dist',
          },
        },
      }),
    });
    const sourcePath = path.join(fixture.rootDir, 'storage/tsconfig.json');
    const symlinkPath = path.join(
      fixture.rootDir,
      'packages/symlink/tsconfig.json',
    );
    const hardlinkPath = path.join(
      fixture.rootDir,
      'packages/hardlink/tsconfig.json',
    );
    const config = createResolvedConfig(fixture.rootDir, {
      checkers: {
        typescript: {
          include: [
            'packages/symlink/tsconfig.json',
            'packages/hardlink/tsconfig.json',
          ],
          preset: 'tsc',
        },
      },
    });

    try {
      await mkdir(path.dirname(symlinkPath), { recursive: true });
      await mkdir(path.dirname(hardlinkPath), { recursive: true });
      await symlink(sourcePath, symlinkPath);
      await link(sourcePath, hardlinkPath);
      await commitFixture(fixture.rootDir);
      const beforeMtime = (await stat(sourcePath, { bigint: true })).mtimeNs;

      const result = await runMigration(config);

      expect(result.modifiedFiles).toEqual([]);
      expect(result.skippedFiles).toEqual(toPortablePaths([hardlinkPath]));
      expect((await stat(sourcePath, { bigint: true })).mtimeNs).toBe(
        beforeMtime,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves unrelated JSONC text while applying governed local edits idempotently', async () => {
    const original = `{
  // repository rationale stays byte-for-byte
  "$schema" : "./legacy-schema.json",
  "compilerOptions": {
    /* strict mode rationale */
    "strict" : true,
    "outDir": "./dist", // output ownership moves to Limina
    "declarationDir": "./dist", // declarations share the artifact root
    "declaration": true,
  },
  "include" : ["src/**/*.ts",],
  "references": [{"path":"../legacy"},],
  "liminaOptions": {
    /* existing output rationale */
    "outputs": {"rootDir":"./existing",},
  },
  "custom" : {"compact":[1,2,3],},
}
`;
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': original,
    });
    const config = createResolvedConfig(fixture.rootDir, {
      checkers: {
        typescript: {
          include: ['tsconfig.json'],
          preset: 'tsc',
        },
      },
    });
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);
      await expect(runMigration(config)).resolves.toMatchObject({
        modifiedFiles: toPortablePaths([configPath]),
      });
      const migrated = await readFile(configPath, 'utf8');
      const parsed = parse(migrated) as {
        $schema?: string;
        compilerOptions?: Record<string, unknown>;
        liminaOptions?: { outputs?: Record<string, unknown> };
        references?: unknown;
      };

      expect(migrated).toBe(`{
  // repository rationale stays byte-for-byte
  "$schema" : "./node_modules/limina/schemas/tsconfig-schema.json",
  "compilerOptions": {
    /* strict mode rationale */
    "strict" : true,
  },
  "include" : ["src/**/*.ts",],
  "liminaOptions": {
    /* existing output rationale */
    "outputs": {
      "rootDir": "./existing",
      "outDir": "./dist",
    },
  },
  "custom" : {"compact":[1,2,3],},
}
`);
      expect(migrated).not.toMatch(
        /"compilerOptions": \{\r?\n(?:[ \t]*\r?\n)+/u,
      );
      expect(migrated).toContain('// repository rationale stays byte-for-byte');
      expect(migrated).toContain('/* strict mode rationale */');
      expect(migrated).toContain('/* existing output rationale */');
      expect(migrated).not.toContain('// output ownership moves to Limina');
      expect(migrated).toContain('"include" : ["src/**/*.ts",]');
      expect(migrated).toContain('"custom" : {"compact":[1,2,3],}');
      expect(parsed).toMatchObject({
        $schema: rootSchemaPath,
        compilerOptions: { strict: true },
        liminaOptions: {
          outputs: {
            outDir: './dist',
            rootDir: './existing',
          },
        },
      });
      expect(parsed.references).toBeUndefined();

      await commitFixture(fixture.rootDir);
      await expect(runMigration(config)).resolves.toMatchObject({
        modifiedFiles: [],
        skippedFiles: toPortablePaths([configPath]),
      });
      await expect(readFile(configPath, 'utf8')).resolves.toBe(migrated);
    } finally {
      await fixture.cleanup();
    }
  });

  it('moves declarationDir-only output into Limina managed outputs', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': json({
        compilerOptions: {
          declarationDir: './types',
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
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);

      await expect(runMigration(config)).resolves.toMatchObject({
        modifiedFiles: toPortablePaths([configPath]),
      });
      await expect(
        readJson<{
          compilerOptions?: Record<string, unknown>;
          liminaOptions?: { outputs?: Record<string, unknown> };
        }>(configPath),
      ).resolves.toMatchObject({
        liminaOptions: { outputs: { outDir: './types' } },
      });
      await expect(
        readJson<Record<string, unknown>>(configPath),
      ).resolves.not.toHaveProperty('compilerOptions.declarationDir');
      const migrated = await readFile(configPath, 'utf8');
      await commitFixture(fixture.rootDir);
      await expect(runMigration(config)).resolves.toMatchObject({
        modifiedFiles: [],
        skippedFiles: toPortablePaths([configPath]),
      });
      await expect(readFile(configPath, 'utf8')).resolves.toBe(migrated);
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves CRLF, tabs, comments, and trailing commas in JSONC declarationDir edits', async () => {
    const original =
      '{\r\n' +
      '\t// keep this root comment\r\n' +
      '\t"compilerOptions": {\r\n' +
      '\t\t/* declaration ownership */\r\n' +
      '\t\t"declarationDir": "./types", // remove this suffix\r\n' +
      '\t\t"strict": true, // keep strict\r\n' +
      '\t},\r\n' +
      '\t"include": ["src/**/*.ts"],\r\n' +
      '\t"liminaOptions": {\r\n' +
      '\t\t"outputs": {"outDir": "./types",},\r\n' +
      '\t},\r\n' +
      '\t"custom": {"compact": [1, 2, 3],},\r\n' +
      '}\r\n';
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': original,
    });
    const config = createResolvedConfig(fixture.rootDir, {
      checkers: {
        typescript: {
          include: ['tsconfig.json'],
          preset: 'tsc',
        },
      },
    });
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);
      await expect(runMigration(config)).resolves.toMatchObject({
        modifiedFiles: toPortablePaths([configPath]),
      });
      const migrated = await readFile(configPath, 'utf8');
      expect(migrated).toContain('\r\n');
      expect(migrated).not.toMatch(/(?<!\r)\n/u);
      expect(migrated).toContain('\t');
      expect(migrated).toContain('// keep this root comment');
      expect(migrated).toContain('"strict": true, // keep strict');
      expect(migrated).toContain('"include": ["src/**/*.ts"],');
      expect(migrated).toContain('"custom": {"compact": [1, 2, 3],}');
      expect(migrated).not.toContain('declaration ownership');
      expect(migrated).not.toContain('remove this suffix');
      expect(migrated).not.toContain('"declarationDir"');
      expect(migrated).toContain('"outDir": "./types"');

      await commitFixture(fixture.rootDir);
      await expect(runMigration(config)).resolves.toMatchObject({
        modifiedFiles: [],
        skippedFiles: toPortablePaths([configPath]),
      });
      await expect(readFile(configPath, 'utf8')).resolves.toBe(migrated);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects split declarationDir output before writing', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': json({
        compilerOptions: {
          declarationDir: './types',
          outDir: './dist',
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
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);
      const before = await readFile(configPath);

      await expect(runMigration(config)).rejects.toThrow(
        /declarationDir[\s\S]*types[\s\S]*effective compilerOptions\.outDir[\s\S]*dist[\s\S]*one managed artifact output root/u,
      );
      await expect(readFile(configPath)).resolves.toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not write earlier targets when a later split declarationDir fails', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'packages/a/src/index.ts': 'export const a = 1;\n',
      'packages/a/tsconfig.json': json({
        compilerOptions: { declarationDir: './types' },
        include: ['src/**/*.ts'],
      }),
      'packages/z/src/index.ts': 'export const z = 1;\n',
      'packages/z/tsconfig.json': json({
        compilerOptions: {
          declarationDir: './types',
          outDir: './dist',
        },
        include: ['src/**/*.ts'],
      }),
    });
    const config = createResolvedConfig(fixture.rootDir, {
      checkers: {
        typescript: {
          include: ['packages/*/tsconfig.json'],
          preset: 'tsc',
        },
      },
    });
    const firstPath = path.join(fixture.rootDir, 'packages/a/tsconfig.json');
    const laterPath = path.join(fixture.rootDir, 'packages/z/tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);
      const firstBefore = await readFile(firstPath);
      const laterBefore = await readFile(laterPath);
      await expect(runMigration(config)).rejects.toThrow(
        /one managed artifact output root/u,
      );
      await expect(readFile(firstPath)).resolves.toEqual(firstBefore);
      await expect(readFile(laterPath)).resolves.toEqual(laterBefore);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ['./dist', 'dist'],
    ['dist', './build/../dist'],
    ['./build', 'build'],
  ])(
    'treats equivalent output paths as one managed root (%s, %s)',
    async (outDir, declarationDir) => {
      const fixture = await createFixture({
        'limina.config.mjs': 'export default {};\n',
        'src/index.ts': 'export const value = 1;\n',
        'tsconfig.json': json({
          compilerOptions: { declarationDir, outDir },
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
      const configPath = path.join(fixture.rootDir, 'tsconfig.json');

      try {
        await commitFixture(fixture.rootDir);
        await expect(runMigration(config)).resolves.toMatchObject({
          modifiedFiles: toPortablePaths([configPath]),
        });
        await expect(
          readJson<{
            compilerOptions?: Record<string, unknown>;
            liminaOptions?: { outputs?: Record<string, unknown> };
          }>(configPath),
        ).resolves.toMatchObject({
          liminaOptions: { outputs: { outDir } },
        });
        await expect(
          readJson<Record<string, unknown>>(configPath),
        ).resolves.not.toHaveProperty('compilerOptions.declarationDir');
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('cleans an equivalent declarationDir from an old half-migrated config', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': json({
        compilerOptions: { declarationDir: './dist' },
        include: ['src/**/*.ts'],
        liminaOptions: { outputs: { outDir: 'dist' } },
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
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);
      await expect(runMigration(config)).resolves.toMatchObject({
        modifiedFiles: toPortablePaths([configPath]),
      });
      await expect(
        readJson<Record<string, unknown>>(configPath),
      ).resolves.toEqual({
        $schema: rootSchemaPath,
        include: ['src/**/*.ts'],
        liminaOptions: { outputs: { outDir: 'dist' } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps multi-level inherited declarationDir and does not copy it into a leaf', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.base.json': json({
        compilerOptions: { declarationDir: './types' },
      }),
      'tsconfig.mid.json': json({
        extends: './tsconfig.base.json',
      }),
      'tsconfig.json': json({
        extends: './tsconfig.mid.json',
        compilerOptions: { outDir: './dist' },
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
    const basePath = path.join(fixture.rootDir, 'tsconfig.base.json');
    const midPath = path.join(fixture.rootDir, 'tsconfig.mid.json');
    const leafPath = path.join(fixture.rootDir, 'tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);
      const baseBefore = await readFile(basePath);
      const midBefore = await readFile(midPath);
      await expect(runMigration(config)).resolves.toMatchObject({
        modifiedFiles: toPortablePaths([leafPath]),
      });
      await expect(readFile(basePath)).resolves.toEqual(baseBefore);
      await expect(readFile(midPath)).resolves.toEqual(midBefore);
      await expect(
        readJson<Record<string, unknown>>(leafPath),
      ).resolves.toEqual({
        $schema: rootSchemaPath,
        extends: './tsconfig.mid.json',
        include: ['src/**/*.ts'],
        liminaOptions: { outputs: { outDir: './dist' } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects direct declarationDir against an inherited effective outDir', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.base.json': json({
        compilerOptions: { outDir: './dist' },
      }),
      'tsconfig.json': json({
        extends: './tsconfig.base.json',
        compilerOptions: { declarationDir: './types' },
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
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);
      const before = await readFile(configPath);
      await expect(runMigration(config)).rejects.toThrow(
        /effective compilerOptions\.outDir[\s\S]*dist[\s\S]*one managed artifact output root/u,
      );
      await expect(readFile(configPath)).resolves.toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses the default planned dist root when existing outputs omit outDir', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': json({
        compilerOptions: { declarationDir: './dist' },
        include: ['src/**/*.ts'],
        liminaOptions: { outputs: { rootDir: './src' } },
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
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);
      await expect(runMigration(config)).resolves.toMatchObject({
        modifiedFiles: toPortablePaths([configPath]),
      });
      await expect(
        readJson<Record<string, unknown>>(configPath),
      ).resolves.toEqual({
        $schema: rootSchemaPath,
        include: ['src/**/*.ts'],
        liminaOptions: { outputs: { rootDir: './src' } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('lets another moved output field create the default planned root', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': json({
        compilerOptions: {
          declarationDir: './dist',
          rootDir: './src',
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
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);
      await expect(runMigration(config)).resolves.toMatchObject({
        modifiedFiles: toPortablePaths([configPath]),
      });
      await expect(
        readJson<Record<string, unknown>>(configPath),
      ).resolves.toEqual({
        $schema: rootSchemaPath,
        include: ['src/**/*.ts'],
        liminaOptions: { outputs: { rootDir: './src' } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects declarationDir against an existing managed output root', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': json({
        compilerOptions: { declarationDir: './types' },
        include: ['src/**/*.ts'],
        liminaOptions: { outputs: { outDir: './dist' } },
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
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);
      const before = await readFile(configPath);
      await expect(runMigration(config)).rejects.toThrow(
        /existing liminaOptions\.outputs\.outDir[\s\S]*dist[\s\S]*planned managed output root[\s\S]*one managed artifact output root/u,
      );
      await expect(readFile(configPath)).resolves.toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });

  it('removes an equivalent absolute declarationDir without copying it', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': json({
        compilerOptions: {
          declarationDir: '__FIXTURE_ROOT__/dist',
        },
        include: ['src/**/*.ts'],
        liminaOptions: { outputs: { outDir: './dist' } },
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
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');

    try {
      const content = await readFile(configPath, 'utf8');
      await writeText(
        configPath,
        content.replace('__FIXTURE_ROOT__', fixture.rootDir),
      );
      await commitFixture(fixture.rootDir);
      await expect(runMigration(config)).resolves.toMatchObject({
        modifiedFiles: toPortablePaths([configPath]),
      });
      await expect(
        readJson<Record<string, unknown>>(configPath),
      ).resolves.toEqual({
        $schema: rootSchemaPath,
        include: ['src/**/*.ts'],
        liminaOptions: { outputs: { outDir: './dist' } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects an absolute declarationDir when no managed root exists', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': json({
        compilerOptions: {
          declarationDir: '__FIXTURE_ROOT__/types',
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
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');

    try {
      const content = await readFile(configPath, 'utf8');
      await writeText(
        configPath,
        content.replace('__FIXTURE_ROOT__', fixture.rootDir),
      );
      await commitFixture(fixture.rootDir);
      const before = await readFile(configPath);
      await expect(runMigration(config)).rejects.toThrow(
        /absolute declarationDir has no planned managed output root/u,
      );
      await expect(readFile(configPath)).resolves.toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects an invalid direct declarationDir before writing', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': json({
        compilerOptions: { declarationDir: 42 },
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
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);
      const before = await readFile(configPath);
      await expect(runMigration(config)).rejects.toThrow(/declarationDir/u);
      await expect(readFile(configPath)).resolves.toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects declarationDir combined with an effective outFile', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': json({
        compilerOptions: {
          declarationDir: './dist',
          outFile: './dist/bundle.js',
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
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');

    try {
      await commitFixture(fixture.rootDir);
      const before = await readFile(configPath);
      await expect(runMigration(config)).rejects.toThrow(
        /outFile is effective together with declarationDir/u,
      );
      await expect(readFile(configPath)).resolves.toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });

  it('removes direct declarationDir from a pure solution without creating outputs', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': json({
        compilerOptions: { declarationDir: './types' },
        files: [],
        references: [{ path: './tsconfig.lib.json' }],
      }),
      'packages/app/tsconfig.lib.json': json({
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
    const solutionPath = path.join(
      fixture.rootDir,
      'packages/app/tsconfig.json',
    );

    try {
      await commitFixture(fixture.rootDir);
      await expect(runMigration(config)).resolves.toMatchObject({
        checkerEntryCount: 1,
        modifiedFiles: toPortablePaths([
          solutionPath,
          path.join(fixture.rootDir, 'packages/app/tsconfig.lib.json'),
        ]),
      });
      await expect(
        readJson<Record<string, unknown>>(solutionPath),
      ).resolves.toEqual({
        $schema: nestedPackageSchemaPath,
        files: [],
        references: [{ path: './tsconfig.lib.json' }],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not apply declarationDir-only mixed-solution validation without a direct field', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': json({
        files: [],
        include: ['src/**/*.ts'],
        references: [{ path: './tsconfig.lib.json' }],
      }),
      'packages/app/tsconfig.lib.json': json({
        compilerOptions: { outDir: './dist' },
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
    const solutionPath = path.join(
      fixture.rootDir,
      'packages/app/tsconfig.json',
    );
    const leafPath = path.join(
      fixture.rootDir,
      'packages/app/tsconfig.lib.json',
    );

    try {
      await commitFixture(fixture.rootDir);
      await expect(runMigration(config)).resolves.toMatchObject({
        checkerEntryCount: 1,
        modifiedFiles: toPortablePaths([solutionPath, leafPath]),
      });
      await expect(readFile(solutionPath, 'utf8')).resolves.not.toContain(
        'mixed aggregator with effective source inputs',
      );
      await expect(
        readJson<Record<string, unknown>>(leafPath),
      ).resolves.toMatchObject({
        liminaOptions: { outputs: { outDir: './dist' } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('treats .vue inputs as effective mixed-solution sources', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'packages/app/src/App.vue': '<script setup lang="ts">\n</script>\n',
      'packages/app/tsconfig.json': json({
        compilerOptions: { declarationDir: './types' },
        files: [],
        include: ['src/**/*.vue'],
        references: [{ path: './tsconfig.lib.json' }],
      }),
      'packages/app/tsconfig.lib.json': json({
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
    const solutionPath = path.join(
      fixture.rootDir,
      'packages/app/tsconfig.json',
    );
    const leafPath = path.join(
      fixture.rootDir,
      'packages/app/tsconfig.lib.json',
    );
    const solutionBefore = await readFile(solutionPath);
    const leafBefore = await readFile(leafPath);

    try {
      await commitFixture(fixture.rootDir);
      await expect(runMigration(config)).rejects.toThrow(
        /mixed aggregator with effective source inputs/u,
      );
      await expect(readFile(solutionPath)).resolves.toEqual(solutionBefore);
      await expect(readFile(leafPath)).resolves.toEqual(leafBefore);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a mixed solution with direct declarationDir before writing', async () => {
    const fixture = await createFixture({
      'limina.config.mjs': 'export default {};\n',
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': json({
        compilerOptions: { declarationDir: './types' },
        files: [],
        include: ['src/**/*.ts'],
        references: [{ path: './tsconfig.lib.json' }],
      }),
      'packages/app/tsconfig.lib.json': json({
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
    const solutionPath = path.join(
      fixture.rootDir,
      'packages/app/tsconfig.json',
    );

    try {
      await commitFixture(fixture.rootDir);
      const before = await readFile(solutionPath);
      await expect(runMigration(config)).rejects.toThrow(
        /mixed aggregator with effective source inputs/u,
      );
      await expect(readFile(solutionPath)).resolves.toEqual(before);
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
