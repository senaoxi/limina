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

function linkDependencies(directory: string) {
  for (const name of [
    '.bin',
    '@commitlint/cli',
    '@commitlint/config-conventional',
    'husky',
    'limina',
    'semver',
  ]) {
    const destination = path.join(directory, 'node_modules', name);
    const source = fileURLToPath(
      new URL(`../../node_modules/${name}`, import.meta.url),
    );
    mkdirSync(path.dirname(destination), { recursive: true });
    symlinkSync(realpathSync(source), destination, 'junction');
  }
}

function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'limina git hooks '));
  for (const file of [
    '.husky/commit-msg',
    'commitlint.config.mjs',
    'limina.config.mts',
    'scripts/git/commit-message.ts',
  ]) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    copyFileSync(
      fileURLToPath(new URL(`../../${file}`, import.meta.url)),
      path.join(directory, file),
    );
  }
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  writeFileSync(path.join(directory, 'global.config'), '');
  linkDependencies(directory);
  const environment = {
    ...process.env,
    CI: '',
    HUSKY: '1',
    NODE_ENV: '',
    XDG_CONFIG_HOME: path.join(directory, 'user-config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(directory, 'global.config'),
    GIT_EDITOR: ':',
  };
  const runGit = (...arguments_: string[]) =>
    spawnSync('git', arguments_, {
      cwd: directory,
      env: environment,
      encoding: 'utf8',
    });
  const git = (...arguments_: string[]) => {
    const result = runGit(...arguments_);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Hook fixture');
  git('config', 'commit.gpgsign', 'false');
  const messageFile = path.join(directory, 'commit message.txt');
  const check = (message: string) => {
    writeFileSync(messageFile, message);
    const result = spawnSync(
      process.execPath,
      ['scripts/git/commit-message.ts', messageFile],
      {
        cwd: directory,
        env: environment,
        encoding: 'utf8',
      },
    );
    assert.equal(
      readFileSync(messageFile, 'utf8'),
      message,
      'validation must not rewrite the message',
    );
    return result;
  };
  const install = (overrides: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      process.execPath,
      [path.join(directory, 'node_modules/husky/bin.js')],
      {
        cwd: directory,
        env: { ...environment, ...overrides },
        encoding: 'utf8',
      },
    );
  const commitlint = (message: string) =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.resolve('@commitlint/cli/cli.js')),
        '--cwd',
        directory,
        '--config',
        path.join(directory, 'commitlint.config.mjs'),
        '--strict',
        '--color=false',
      ],
      { cwd: directory, env: environment, encoding: 'utf8', input: message },
    );
  return { directory, environment, git, runGit, check, install, commitlint };
}

it('accepts convention examples, boundary lengths and generated release pairs through the CLI', () => {
  const fixture = createFixture();
  try {
    for (const type of [
      'feat',
      'fix',
      'docs',
      'style',
      'refactor',
      'perf',
      'test',
      'build',
      'ci',
      'chore',
    ]) {
      const result = fixture.check(`${type}: preserve behavior\n`);
      assert.equal(result.status, 0, result.stderr);
    }
    for (const message of [
      'fix(migrate): preserve healthy sources and native relations\n\n- retain source identity when configuration analysis fails\n- preserve native references that cannot be inferred\n- cover incomplete analysis with regression tests\n',
      'feat(checker)!: require explicit checker identities\n\n- replace checker aliases with fixed checker names\n- update configuration diagnostics and migration guidance\n\nBREAKING CHANGE: config.checkers no longer accepts checker aliases or the\npreset field. Replace alias entries with supported checker-name keys.\n',
      'feat!: require explicit identities\n\nBREAKING CHANGE: aliases are removed. Replace them with supported keys.\n',
      'revert: fix(checker): preserve typeRoots\n\n- revert commit abc123 because it changes resolution\n',
      `fix(checker): ${'a'.repeat(50)}`,
      `fix(${'checker'.repeat(20)}): preserve subject-only limits`,
      `fix: a${'x'.repeat(48)}😀`,
      'fix: a',
      'fix: preserve TypeScript behavior\r\n\r\n- retain @astrojs/check support\r\n',
      `fix: preserve unbounded body lines\n\n- retain ${'identifiers'.repeat(20)}`,
      `feat!: preserve unbounded footer lines\n\nBREAKING CHANGE: replace ${'identifiers'.repeat(20)}.`,
      'fix: preserve issue references\n\n- retain behavior\n- close #123 when the guard succeeds',
      'release: limina@1.2.3, migrate@1.2.3\n',
      'release: limina@1.2.3-alpha.0, migrate@1.2.3-alpha.0\n',
      'release: limina@1.2.3-beta.2+build.01, migrate@1.2.3-beta.2+build.01\n',
      `release: limina@1.2.3+${'build'.repeat(20)}, migrate@1.2.3+${'build'.repeat(20)}\n`,
    ]) {
      const result = fixture.check(message);
      assert.equal(result.status, 0, `${message}\n${result.stderr}`);
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it('rejects malformed headers, non-bullet bodies, separators and breaking footer mismatches', () => {
  const fixture = createFixture();
  try {
    for (const message of [
      '',
      '\nfix: add a guard',
      'feature: add a guard',
      'release: improve tooling',
      'fix(checker)(docs): add a guard',
      'fix(): add a guard',
      'fix( checker ): add a guard',
      'fix: ',
      'fix: Add a guard',
      'fix: 添加校验',
      'fix: add a guard.',
      'fix: add a guard ',
      `fix: ${'a'.repeat(51)}`,
      'fix: add a guard\t',
      'fix: add a guard\n- reject invalid headers',
      'fix: add a guard\n\n\n- reject invalid headers',
      'fix: add a guard\n\nExplain the change',
      'fix: add a guard\n\n# Details',
      'fix: add a guard\n\n* reject invalid headers',
      'fix: add a guard\n\n1. reject invalid headers',
      'fix: add a guard\n\n- Reject invalid headers',
      'fix: add a guard\n\n- reject invalid headers.',
      'fix: add a guard\n\n- reject invalid headers\n  and bodies',
      'fix: add a guard\n\n- reject invalid headers\n\n- reject invalid bodies',
      'feat!: remove aliases',
      'feat: remove aliases\n\nBREAKING CHANGE: replace aliases with explicit keys.',
      'feat!: remove aliases\n\n- reject aliases\nBREAKING CHANGE: replace aliases with explicit keys.',
      'feat!: remove aliases\n\n- reject aliases\n\n\nBREAKING CHANGE: replace aliases with explicit keys.',
      'feat!: remove aliases\n\nBREAKING CHANGE:',
      'feat!: remove aliases\n\nBREAKING CHANGES: replace aliases with explicit keys.',
      'feat!: remove aliases\n\nBREAKING-CHANGE: replace aliases with explicit keys.',
      'feat!: remove aliases\n\n- BREAKING CHANGE: replace aliases with explicit keys.',
      'feat!: remove aliases\n\nBREAKING CHANGE: Replace aliases with explicit keys.',
      'feat!: remove aliases\n\nBREAKING CHANGE: replace aliases with explicit keys.\n\nMigrate the configuration.',
      'feat!: remove aliases\n\nBREAKING CHANGE: replace aliases with explicit keys.\n- reject aliases',
      'feat!: remove aliases\n\nBREAKING CHANGE: replace aliases with explicit keys.\nBREAKING CHANGE: replace the CLI.',
      'revert(checker): remove a guard',
      'revert: fix(checker): remove a guard',
      'fixup! fix: add a guard',
      'squash! fix: add a guard',
      'Merge branch main',
      'release: limina@1.2.3',
      'release: limina@1.2.3, migrate@1.2.4',
      'release: limina@01.2.3, migrate@01.2.3',
      'release: limina@1.2.3-beta.01, migrate@1.2.3-beta.01',
      'release: limina@v1.2.3, migrate@v1.2.3',
      'release: limina@1.2.3, migrate@1.2.3 ',
      'release: limina@1.2.3, migrate@1.2.3\n\n- skip the guard',
    ]) {
      const result = fixture.check(message);
      assert.equal(result.status, 1, `unexpectedly accepted: ${message}`);
      assert.match(result.stderr, /^commit-msg: /u);
      assert.match(result.stderr, /See \.github\/commit-convention\.md\n$/u);
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it('uses the shared commitlint configuration through both the wrapper and upstream CLI', () => {
  const fixture = createFixture();
  try {
    for (const message of [
      'fix: preserve the shared configuration',
      'release: limina@1.2.3, migrate@1.2.3',
    ]) {
      const accepted = fixture.commitlint(message);
      assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    }
    for (const message of [
      'fixup! fix: preserve configuration',
      'Merge branch main',
      'release: limina@1.2.3, migrate@1.2.3 ',
      'fix: preserve configuration\n\nExplain the change',
    ]) {
      const rejected = fixture.commitlint(message);
      assert.equal(rejected.status, 3, rejected.stderr || rejected.stdout);
    }
    copyFileSync(
      path.join(fixture.directory, 'commitlint.config.mjs'),
      path.join(fixture.directory, 'commitlint.base.mjs'),
    );
    writeFileSync(
      path.join(fixture.directory, 'commitlint.config.mjs'),
      "import base from './commitlint.base.mjs';\nexport default { ...base, rules: { ...base.rules, 'type-enum': [2, 'always', ['docs']] } };\n",
    );
    const rejected = fixture.check('fix: preserve the shared configuration');
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /\[type-enum\]/u);
    const accepted = fixture.check('docs: preserve the shared configuration');
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it('handles configured Git comments and explicit editor scissors without hiding retained content', () => {
  const fixture = createFixture();
  try {
    fixture.git('config', 'commit.cleanup', 'strip');
    for (const prefix of ['#', ';', '//']) {
      fixture.git('config', 'core.commentChar', prefix);
      const supported = spawnSync('git', ['stripspace', '--strip-comments'], {
        cwd: fixture.directory,
        env: fixture.environment,
        encoding: 'utf8',
        input: `${prefix} comment\n`,
      });
      if (supported.status !== 0) continue;
      const result = fixture.check(
        `fix: add a guard\r\n\r\n- reject invalid headers\r\n\r\n${prefix} status\r\n`,
      );
      assert.equal(result.status, 0, result.stderr);
    }
    fixture.git('config', 'core.commentString', '//');
    fixture.git('config', 'core.commentChar', ';');
    for (const prefix of [';', '//']) {
      const comment = `${prefix} comment`;
      const cleaned = spawnSync('git', ['stripspace', '--strip-comments'], {
        cwd: fixture.directory,
        env: fixture.environment,
        encoding: 'utf8',
        input: `${comment}\n`,
      });
      assert.equal(cleaned.status, 0, cleaned.stderr);
      const overridden = fixture.check(`fix: add a guard\n${comment}\n`);
      assert.equal(
        overridden.status,
        cleaned.stdout === '' ? 0 : 1,
        overridden.stderr,
      );
    }
    for (const cleanup of ['whitespace', 'verbatim']) {
      fixture.git('config', 'commit.cleanup', cleanup);
      const result = fixture.check(
        'fix: add a guard\n\n; this line will be retained',
      );
      assert.equal(result.status, 1, result.stderr);
    }
    fixture.git('config', 'core.commentChar', '#');
    fixture.git('config', 'core.commentString', '#');
    fixture.git('config', 'commit.cleanup', 'scissors');
    const verbose =
      'fix: add a guard\n\n# ------------------------ >8 ------------------------\ndiff --git a/file b/file\n';
    assert.equal(
      fixture.check(verbose).status,
      1,
      'non-editor scissors content must be checked',
    );
    fixture.environment.GIT_EDITOR = 'fixture-editor';
    const edited = fixture.check(verbose);
    assert.equal(edited.status, 0, edited.stderr);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it('rejects literal scissors under strip cleanup and accepts edited verbose commits with scissors cleanup', () => {
  const fixture = createFixture();
  try {
    const installed = fixture.install();
    assert.equal(installed.status, 0, installed.stderr);
    fixture.git(
      'add',
      '.husky',
      'commitlint.config.mjs',
      'limina.config.mts',
      'scripts',
      'package.json',
    );
    fixture.git('commit', '--quiet', '-m', 'chore: add Git hooks');
    const head = fixture.git('rev-parse', 'HEAD');
    fixture.git('config', 'commit.cleanup', 'strip');
    const literal =
      'fix: preserve strict formatting\n\n# ------------------------ >8 ------------------------\ninvalid plain body';
    const rejected = fixture.runGit(
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      literal,
    );
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /body line must/u);
    assert.equal(fixture.git('rev-parse', 'HEAD'), head);
    const editor = path.join(fixture.directory, 'editor.cjs');
    writeFileSync(editor, 'process.exitCode = 0;\n');
    fixture.environment.GIT_EDITOR = `"${process.execPath}" "${editor}"`;
    const editedLiteral = fixture.runGit(
      'commit',
      '--quiet',
      '--allow-empty',
      '--edit',
      '-m',
      literal,
    );
    assert.equal(editedLiteral.status, 1, editedLiteral.stderr);
    assert.equal(fixture.git('rev-parse', 'HEAD'), head);
    fixture.git('config', 'commit.cleanup', 'scissors');
    writeFileSync(path.join(fixture.directory, 'change.txt'), 'verbose diff\n');
    fixture.git('add', 'change.txt');
    fixture.git(
      'commit',
      '--quiet',
      '--verbose',
      '--edit',
      '-m',
      'fix: preserve edited messages',
      '-m',
      '- retain configured Git cleanup',
    );
    assert.equal(
      fixture.git('log', '-1', '--format=%B'),
      'fix: preserve edited messages\n\n- retain configured Git cleanup',
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it('installs idempotently and blocks an invalid real Git commit while retaining HEAD and the index', () => {
  const fixture = createFixture();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = fixture.install();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        fixture.git('config', '--local', '--get', 'core.hooksPath'),
        '.husky/_',
      );
    }
    fixture.git(
      'add',
      '.husky',
      'commitlint.config.mjs',
      'limina.config.mts',
      'scripts',
      'package.json',
    );
    fixture.git('commit', '--quiet', '-m', 'chore: add Git hooks');
    const head = fixture.git('rev-parse', 'HEAD');
    writeFileSync(
      path.join(fixture.directory, 'change.txt'),
      'staged change\n',
    );
    fixture.git('add', 'change.txt');
    const index = fixture.git('write-tree');
    const rejected = fixture.runGit(
      'commit',
      '--quiet',
      '-m',
      'fix: Add a guard',
    );
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /subjects must start/u);
    assert.equal(fixture.git('rev-parse', 'HEAD'), head);
    assert.equal(fixture.git('write-tree'), index);
    fixture.git(
      'commit',
      '--quiet',
      '-m',
      'fix: add a guard',
      '-m',
      '- reject invalid headers',
    );
    assert.notEqual(fixture.git('rev-parse', 'HEAD'), head);
    assert.equal(
      fixture.git('log', '-1', '--format=%B'),
      'fix: add a guard\n\n- reject invalid headers',
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it('honors HUSKY=0 and validates commits in a linked Git worktree', () => {
  const fixture = createFixture();
  const worktree = `${fixture.directory} linked`;
  try {
    const skipped = fixture.install({ HUSKY: '0' });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(fixture.runGit('config', '--get', 'core.hooksPath').status, 1);
    fixture.git(
      'add',
      '.husky',
      'commitlint.config.mjs',
      'limina.config.mts',
      'scripts',
      'package.json',
    );
    fixture.git(
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'chore: add Git hooks',
    );
    fixture.git('worktree', 'add', '--quiet', '--detach', worktree);
    linkDependencies(worktree);
    const linked = spawnSync(
      process.execPath,
      [path.join(worktree, 'node_modules/husky/bin.js')],
      {
        cwd: worktree,
        env: fixture.environment,
        encoding: 'utf8',
      },
    );
    assert.equal(linked.status, 0, linked.stderr);
    const rejected = spawnSync(
      'git',
      ['commit', '--quiet', '--allow-empty', '-m', 'fix: Add a guard'],
      { cwd: worktree, env: fixture.environment, encoding: 'utf8' },
    );
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /subjects must start/u);
    execFileSync(
      'git',
      [
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'chore: preserve linked worktree hooks',
      ],
      { cwd: worktree, env: fixture.environment },
    );
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
