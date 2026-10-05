import { spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createFixturePathResolver } from '../../src/__tests__/helpers/path';
import { readCheckIssueSnapshot } from '../../src/check-reporting/snapshot';

it('checks both compiler scopes through the repository typecheck pipeline', async () => {
  const rootDirectory = fileURLToPath(new URL('../../../../', import.meta.url));
  const temporaryPath = await mkdtemp(
    path.join(tmpdir(), 'limina-root-config-'),
  );
  const fixtureRoot = await realpath(temporaryPath);
  const fixturePath = createFixturePathResolver(fixtureRoot);

  try {
    // Exercise the real pipeline and compilers without analyzing the whole repo.
    await writeFile(
      fixturePath('package.json'),
      '{"private":true,"type":"module"}',
    );
    await writeFile(
      fixturePath('pnpm-workspace.yaml'),
      'packages:\n  - packages/*\n',
    );
    await writeFile(
      fixturePath('limina.config.mts'),
      await readFile(path.join(rootDirectory, 'limina.config.mts'), 'utf8'),
    );
    for (const name of [
      'limina',
      'typescript',
      'vue-tsc',
      'vue',
      '@typescript/native-preview',
    ]) {
      const target = fixturePath('node_modules', name);
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(
        await realpath(
          name === 'limina'
            ? path.join(rootDirectory, 'packages/limina')
            : path.join(rootDirectory, 'packages/limina/node_modules', name),
        ),
        target,
        'junction',
      );
    }
    const projects = [
      {
        checker: 'tsgo',
        directory: 'packages/eslint-config',
        file: 'index.ts',
      },
      { checker: 'vue-tsc', directory: 'packages/limina', file: 'index.vue' },
    ];
    for (const project of projects) {
      await mkdir(fixturePath(project.directory), { recursive: true });
      await writeFile(
        fixturePath(project.directory, 'package.json'),
        JSON.stringify({
          name: `@fixture/${project.checker}`,
          private: true,
          type: 'module',
        }),
      );
      await writeFile(
        fixturePath(project.directory, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            composite: true,
            strict: true,
            types: [],
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: [project.file],
        }),
      );
    }
    const writeSources = async (failingChecker?: string) => {
      for (const project of projects) {
        const value = project.checker === failingChecker ? '1' : "'valid'";
        const source =
          project.checker === 'tsgo'
            ? `export const value: string = ${value};\n`
            : `<script setup lang="ts">\nconst value: string = ${value};\n</script>\n<template>{{ value }}</template>\n`;
        await writeFile(fixturePath(project.directory, project.file), source);
      }
    };
    const runTypecheck = () =>
      spawnSync(
        process.execPath,
        [
          path.join(rootDirectory, 'packages/limina/bin/limina.js'),
          '--config',
          fixturePath('limina.config.mts'),
          'check',
          'typecheck',
        ],
        { cwd: fixtureRoot, encoding: 'utf8', timeout: 60_000 },
      );
    await writeSources();
    const baseline = runTypecheck();
    expect(baseline.error).toBeUndefined();
    expect(baseline.status, baseline.stdout + baseline.stderr).toBe(0);
    for (const project of projects) {
      await writeSources(project.checker);
      const failed = runTypecheck();
      const output = failed.stdout + failed.stderr;
      expect(failed.error).toBeUndefined();
      expect(failed.status, output).toBe(1);
      const snapshot = await readCheckIssueSnapshot(fixturePath());
      expect(snapshot?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkerName: project.checker,
            code: 'LIMINA_CHECKER_BUILD_FAILED',
          }),
        ]),
      );
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
