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
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createFixturePathResolver } from '../../src/__tests__/helpers/path';

it('published CLI rejects hiding outputs, persists isolation, prepares the real graph, and reruns without config changes', async () => {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-migration-cli-')),
  );
  const locate = createFixturePathResolver(rootDir);
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const source = (outDir: string) =>
    json({
      compilerOptions: { outDir, rootDir: './src' },
      files: ['./src/index.ts'],
    });
  const files = {
    'package.json': json({
      name: 'migration-cli',
      private: true,
      type: 'module',
    }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    '.gitignore': '.limina/\n',
    'limina.config.mjs': 'const config = {}; export default config;\n',
    'packages/app/package.json': json({ name: '@fixture/app', private: true }),
    'packages/app/bad/tsconfig.json': '{ invalid',
    'packages/app/tool/tsconfig.json': source('.'),
    'packages/app/tool/src/index.ts': 'export const tool = 1;',
    'packages/app/producer/tsconfig.json': source('../generated'),
    'packages/app/producer/src/index.ts': 'export const producer = 1;',
    'packages/app/generated/tsconfig.json': json({
      files: [],
      references: [{ path: './tsconfig.lib.json' }],
    }),
    'packages/app/generated/tsconfig.lib.json': json({ files: ['index.ts'] }),
    'packages/app/generated/index.ts': 'export const member = 1;',
  };
  const git = (args: string[]) =>
    promisify(execFile)('git', args, { cwd: rootDir });
  const commit = async () => {
    await git(['add', '.']);
    await git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--no-gpg-sign',
      '-m',
      'fixture',
    ]);
  };
  const cli = async (args: string[]) => {
    const entry = fileURLToPath(
      new URL(
        args[0] === 'migration'
          ? '../../dist/bin/limina-migrate.js'
          : '../../../limina/dist/bin/limina.js',
        import.meta.url,
      ),
    );
    const result = await promisify(execFile)(
      process.execPath,
      [entry, ...(args[0] === 'migration' ? args.slice(1) : args)],
      {
        cwd: rootDir,
        timeout: 60_000,
        env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
      },
    );
    return { ...result, code: 0 };
  };
  try {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(locate(file)), { recursive: true });
      await writeFile(locate(file), content);
    }
    await git(['init']);
    await commit();
    const migration = await cli(['migration']);
    expect(migration.code, migration.stdout + migration.stderr).toBe(0);
    for (const producer of ['tool', 'producer'])
      expect(
        JSON.parse(
          await readFile(
            locate(`packages/app/${producer}/tsconfig.json`),
            'utf8',
          ),
        ).liminaOptions,
      ).toBeUndefined();
    const graph = await cli(['graph', 'prepare']);
    expect(graph.code, graph.stdout + graph.stderr).toBe(0);
    const manifest = JSON.parse(
      await readFile(locate('.limina/manifest.json'), 'utf8'),
    ) as {
      version: number;
      ownership: { configs: { role: string; config: string }[] };
    };
    expect(manifest.version).toBe(5);
    expect(
      manifest.ownership.configs
        .filter((config) => config.role === 'type')
        .map((config) => config.config)
        .sort(),
    ).toEqual([
      'packages/app/generated/tsconfig.lib.json',
      'packages/app/producer/tsconfig.json',
      'packages/app/tool/tsconfig.json',
    ]);
    const configPaths = Object.keys(files).filter(
      (file) => file.endsWith('.json') || file === 'limina.config.mjs',
    );
    const before = await Promise.all(
      configPaths.map((file) => readFile(locate(file), 'utf8')),
    );
    await commit();
    const second = await cli(['migration']);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    expect(
      await Promise.all(
        configPaths.map((file) => readFile(locate(file), 'utf8')),
      ),
    ).toEqual(before);
    expect((await git(['diff', '--name-only'])).stdout).toBe('');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}, 120_000);
