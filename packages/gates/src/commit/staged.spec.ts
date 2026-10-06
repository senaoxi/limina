import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'limina gates '));
  const put = (file: string, value: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  put('package.json', '{"type":"module"}\n');
  put('.gitignore', 'node_modules/\n');
  for (const file of ['licenses.ts', 'repo.ts', 'commit/staged.ts']) {
    const target = path.join(root, 'packages/gates/src', file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), target);
  }
  for (const name of ['marked', 'yaml']) {
    const target = path.join(root, 'node_modules', name);
    mkdirSync(path.dirname(target), { recursive: true });
    const source = fileURLToPath(
      new URL(`../../node_modules/${name}`, import.meta.url),
    );
    symlinkSync(
      realpathSync(source),
      target,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  put(
    '.husky/pre-commit',
    readFileSync(
      new URL('../../../../.husky/pre-commit', import.meta.url),
      'utf8',
    ),
  );
  const environment = {
    ...process.env,
    HUSKY: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'global.config'),
    XDG_CONFIG_HOME: path.join(root, 'user-config'),
  };
  put('global.config', '');
  const git = (...arguments_: string[]) =>
    execFileSync('git', arguments_, {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '--quiet');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Gate fixture');
  git('config', 'commit.gpgsign', 'false');
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../../../node_modules/husky/bin.js', import.meta.url),
      ),
    ],
    {
      cwd: root,
      env: environment,
    },
  );
  const check = (isStaged = true) =>
    spawnSync(
      process.execPath,
      [
        path.join(root, 'packages/gates/src/commit/staged.ts'),
        ...(isStaged ? ['--staged'] : []),
      ],
      { cwd: tmpdir(), env: environment, encoding: 'utf8' },
    );
  return { root, put, git, check, environment };
}

const policy = '```json\n["MIT", "ISC"]\n```\n';
const review = 'allow-licenses:\n  - MIT\n  - ISC\n';

it('blocks a real commit using the index when an unstaged repair would pass, without changing HEAD, index or worktree', () => {
  const fixture = createFixture();
  try {
    fixture.put('.agents/docs/license-policy.md', policy);
    fixture.put('.github/dependency-review-config.yml', review);
    fixture.git('add', '.');
    assert.equal(fixture.git('ls-files', '--', 'node_modules'), '');
    fixture.git('commit', '--quiet', '-m', 'fixture baseline');
    const head = fixture.git('rev-parse', 'HEAD');
    fixture.put(
      '.github/dependency-review-config.yml',
      review.replace('ISC', 'GPL-3.0'),
    );
    fixture.git('add', '.github/dependency-review-config.yml');
    const index = fixture.git('write-tree');
    fixture.put('.github/dependency-review-config.yml', review);
    assert.equal(fixture.check(false).status, 0);
    assert.equal(fixture.check().status, 1);
    const rejected = spawnSync(
      'git',
      ['commit', '--quiet', '-m', 'fix: preserve policy'],
      {
        cwd: fixture.root,
        env: fixture.environment,
        encoding: 'utf8',
      },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Missing: ISC; unexpected: GPL-3\.0/u);
    assert.equal(fixture.git('rev-parse', 'HEAD'), head);
    assert.equal(fixture.git('write-tree'), index);
    assert.equal(
      readFileSync(
        path.join(fixture.root, '.github/dependency-review-config.yml'),
        'utf8',
      ),
      review,
    );
    fixture.put(
      '.github/dependency-review-config.yml',
      'allow-licenses: [ISC, MIT]\n',
    );
    fixture.git('add', '.github/dependency-review-config.yml');
    fixture.git('commit', '--quiet', '-m', 'fix: preserve policy');
    assert.notEqual(fixture.git('rev-parse', 'HEAD'), head);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

it('rejects missing, ambiguous and malformed staged policy/configuration rather than accepting a working copy', () => {
  const fixture = createFixture();
  try {
    for (const [markdown, yaml] of [
      ['# No data\n', review],
      [policy + policy, review],
      [policy, 'allow-licenses: [MIT, ISC\n'],
      [policy, 'allow-licenses: [MIT, ISC]\nallow-licenses: [MIT]\n'],
      [policy, 'allow-licenses: [MIT, ISC, ISC]\n'],
      [policy, 'allow-licenses: [MIT, 1]\n'],
      [policy, 'allow-licenses: MIT\n'],
      [policy, 'allow-licenses: []\n'],
      [policy, 'fail-on-severity: high\n'],
    ]) {
      fixture.put('.agents/docs/license-policy.md', markdown!);
      fixture.put('.github/dependency-review-config.yml', yaml!);
      fixture.git(
        'add',
        '.agents/docs/license-policy.md',
        '.github/dependency-review-config.yml',
      );
      const result = fixture.check();
      assert.equal(result.status, 1, result.stderr);
      assert.match(
        result.stderr,
        /JSON code block|valid YAML|unique license strings/u,
      );
    }
    fixture.put('.agents/docs/license-policy.md', policy);
    fixture.put('.github/dependency-review-config.yml', review);
    fixture.git('add', '.');
    fixture.git('rm', '--cached', '.agents/docs/license-policy.md');
    assert.equal(fixture.check(false).status, 0);
    assert.equal(fixture.check().status, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
