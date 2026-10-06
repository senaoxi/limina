import { runPublishCommand } from '@limina/gates/release/release';
import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installGatesFixture } from '../gates-fixture';

it('starts releases without an activation switch and retains ordinary preflight checks', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-release-cli-'));
  const root = realpathSync(temporary);
  const put = (relativePath: string, value: string) => {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  const git = (...arguments_: string[]) =>
    execFileSync('git', arguments_, { cwd: root, stdio: 'pipe' });
  const environment = { ...process.env };
  for (const name of [
    'LIMINA_RELEASE_ENABLED',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  ])
    delete environment[name];
  const run = (...arguments_: string[]) => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        path.join(root, 'scripts/release.ts'),
        ...arguments_,
      ],
      { cwd: root, env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  };
  try {
    put(
      'package.json',
      JSON.stringify({
        private: true,
        type: 'module',
      }),
    );
    put('.gitignore', 'node_modules\n');
    put(
      'pnpm-workspace.yaml',
      'packages:\n  - packages/*\npublishBranch: main\n',
    );
    for (const [directory, name] of [
      ['limina', 'limina'],
      ['migrate', 'limina-migrate'],
    ])
      put(
        `packages/${directory}/package.json`,
        JSON.stringify({
          name,
          version: '1.2.3-beta.1',
          publishConfig: { access: 'public' },
        }),
      );
    installGatesFixture(root);
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    copyFileSync(
      fileURLToPath(new URL('../release.ts', import.meta.url)),
      path.join(root, 'scripts/release.ts'),
    );
    git('init', '--quiet');
    git('add', '.');
    git(
      '-c',
      'user.name=Release fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'fixture baseline',
    );
    put('uncommitted.txt', 'Ordinary Git preflight must still reject this.\n');
    for (const version of ['1.2.3', '1.2.3-beta.2'])
      assert.match(
        run(
          '--package',
          'limina',
          '--version',
          version,
          '--skip-changelog',
          '--yes',
        ),
        /Working directory is not clean/u,
      );
    rmSync(path.join(root, 'uncommitted.txt'));
    assert.match(
      run('publish', '--package', 'limina'),
      /provenance publishing requires a supported cloud CI\/CD environment/u,
    );
    assert.equal(git('status', '--porcelain').toString(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('checks the workspace once per release group and retains per-package checks', async () => {
  for (const [skipTests, skipBuild, selector] of [
    [false, false, 'limina'],
    [true, false, 'limina'],
    [false, true, 'migrate'],
    [true, true, 'migrate'],
  ] as const) {
    const calls: { command: string; args: readonly string[]; cwd: unknown }[] =
      [];
    const executor = mock.method(childProcess, 'execFileSync', ((
      command: string,
      arguments_: readonly string[],
      options: { cwd?: unknown },
    ) => {
      calls.push({ command, args: arguments_, cwd: options.cwd });
      const npmArguments = arguments_[0]?.endsWith('npm-cli.js')
        ? arguments_.slice(1)
        : arguments_;
      if (npmArguments[0] === 'pack' && npmArguments.includes('--json'))
        throw new Error('Reached publication pack after release checks');
      return '';
    }) as typeof childProcess.execFileSync);
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        runPublishCommand({
          packageSelectors: [selector],
          dryRun: false,
          skipTests,
          skipBuild,
          provenance: false,
          help: false,
        }),
        /Reached publication pack/u,
      );
      const scripts = calls.filter(
        ({ command, args }) =>
          /^pnpm(?:\.cmd)?$/u.test(command) && args[0] === 'run',
      );
      assert.deepEqual(
        scripts.map(({ args }) => args[1]),
        [
          ...(skipBuild ? [] : ['build']),
          ...(skipTests
            ? []
            : ['test:unit', 'test:tooling', 'test:integration', 'test:smoke']),
        ],
      );
      assert.ok(
        scripts.every(
          ({ cwd }) =>
            realpathSync(cwd as string) ===
            realpathSync(fileURLToPath(new URL('../../', import.meta.url))),
        ),
      );
      for (const pipeline of ['packages', 'release']) {
        const checks = calls.filter(
          ({ args }) => args[0] === 'exec' && args.includes(pipeline),
        );
        assert.deepEqual(
          checks.map(({ args }) => args.at(-1)),
          skipBuild ? [] : ['limina', 'limina-migrate'],
        );
      }
    } finally {
      executor.mock.restore();
      syncBuiltinESMExports();
    }
  }
});
