import {
  mkdir,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { expectLiminaSuccess, runFixtureLimina } from '../helpers/assertions';
import { type PreparedFixture, prepareFixture } from '../helpers/fixture';
import { runLimina } from '../helpers/run-limina';

async function fixture() {
  const prepared = await prepareFixture('source-package-incremental');
  await mkdir(prepared.path('repo/packages/app/node_modules/@audit'), {
    recursive: true,
  });
  await symlink(
    prepared.path('repo/packages/lib'),
    prepared.path('repo/packages/app/node_modules/@audit/lib'),
    'junction',
  );
  return prepared;
}

async function expectTypeFailure(
  prepared: PreparedFixture,
  arguments_: string[],
) {
  const result = await runFixtureLimina(prepared, arguments_);
  expect(result.timedOut).toBe(false);
  expect(result.code, result.stdout + result.stderr).toBe(1);
  return result;
}

async function directCompilerFailure(prepared: PreparedFixture) {
  const require = createRequire(import.meta.url);
  const result = await runLimina({
    cwd: prepared.cwd,
    fixtureName: prepared.fixtureName,
    entry: {
      executable: process.execPath,
      args: [require.resolve('typescript/bin/tsc')],
    },
    args: [
      '-b',
      '.limina/tsconfig/checkers/tsc/tsconfig.build.json',
      '--force',
      '--pretty',
      'false',
    ],
  });
  expect(result.code, result.stdout + result.stderr).toBe(2);
  expect(result.stdout).toContain('TS2322');
}

describe('source package incremental checking', () => {
  it('rejects a changed external source type after a successful cold and warm check', async () => {
    const prepared = await fixture();
    try {
      expectLiminaSuccess(await runFixtureLimina(prepared, ['check']));
      const libraryInfo = prepared.path(
        'repo/.limina/tsbuildinfo/checkers/tsc/packages/lib/tsconfig.json.tsbuildinfo',
      );
      const unchangedInfo = await stat(libraryInfo);
      expectLiminaSuccess(await runFixtureLimina(prepared, ['check']));
      expect((await stat(libraryInfo)).mtimeMs).toBe(unchangedInfo.mtimeMs);
      const generatedPath = prepared.path(
        'repo/.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.dts.json',
      );
      const config = JSON.parse(await readFile(generatedPath, 'utf8')) as {
        references: unknown[];
      };
      expect(config.references).toEqual([]);
      await writeFile(
        prepared.path('repo/packages/lib/src/index.ts'),
        'export const label: number = 42;\n',
      );
      await expectTypeFailure(prepared, ['check']);
      const report = JSON.parse(
        await readFile(
          prepared.path('repo/.limina/check/last-run.json'),
          'utf8',
        ),
      ) as { issues: { code: string }[] };
      expect(
        report.issues.some(
          (issue) => issue.code === 'LIMINA_CHECKER_BUILD_FAILED',
        ),
      ).toBe(true);
      await directCompilerFailure(prepared);
      await writeFile(
        prepared.path('repo/packages/lib/src/index.ts'),
        "export const label: string = 'ready';\n",
      );
      expectLiminaSuccess(await runFixtureLimina(prepared, ['check']));
    } finally {
      await prepared.cleanup();
    }
  });

  it('checks a transitive source change with unchanged mtime under analysis force', async () => {
    const prepared = await fixture();
    try {
      const leaf = prepared.path('repo/packages/lib/src/value.ts');
      await writeFile(leaf, "export const label: string = 'ready';\n");
      await writeFile(
        prepared.path('repo/packages/lib/src/index.ts'),
        "export { label } from './value.js';\n",
      );
      expectLiminaSuccess(await runFixtureLimina(prepared, ['check']));
      const before = await stat(leaf);
      await writeFile(leaf, 'export const label: number = 42;\n');
      await utimes(leaf, before.atime, before.mtime);
      await expectTypeFailure(prepared, ['check', '--force']);
      await directCompilerFailure(prepared);
    } finally {
      await prepared.cleanup();
    }
  });

  it('rechecks source inputs for managed user-output builds too', async () => {
    const prepared = await fixture();
    try {
      const configPath = prepared.path('repo/packages/app/tsconfig.json');
      const parsed = ts.readConfigFile(configPath, ts.sys.readFile);
      expect(parsed.error).toBeUndefined();
      const config = parsed.config as object;
      await writeFile(
        configPath,
        JSON.stringify({
          ...config,
          liminaOptions: { outputs: { rootDir: './src', outDir: './dist' } },
        }),
      );
      const arguments_ = ['build', 'packages/app/tsconfig.json'];
      expectLiminaSuccess(await runFixtureLimina(prepared, arguments_));
      await writeFile(
        prepared.path('repo/packages/lib/src/index.ts'),
        'export const label: number = 42;\n',
      );
      const result = await expectTypeFailure(prepared, arguments_);
      expect(result.stdout + result.stderr).toContain('2322');
    } finally {
      await prepared.cleanup();
    }
  });
});
