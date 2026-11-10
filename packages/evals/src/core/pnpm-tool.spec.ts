import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { codexEnvironment, taskTools } from '../runner/local-codex.ts';
import { preparePnpmTool } from '../runner/pnpm-tool.ts';

function fixture(t: TestContext) {
  const temporaryRoot = realpathSync.native(tmpdir());
  const root = mkdtempSync(path.join(temporaryRoot, 'eval-pnpm-tool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const binaries = path.join(root, 'underlying tools');
  mkdirSync(workspace);
  mkdirSync(binaries);
  const pnpm = path.join(binaries, 'pnpm');
  const log = path.join(root, 'pnpm.jsonl');
  writeFileSync(
    pnpm,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PNPM_TEST_LOG, JSON.stringify({ args, node: process.execPath, offline: process.env.npm_config_offline, hooks: process.env.npm_config_ignore_scripts, verify: process.env.npm_config_verify_deps_before_run }) + '\\n');
if (process.env.PNPM_TEST_BUILD && args.includes('build')) {
  const result = require('node:child_process').spawnSync(process.execPath, [process.env.PNPM_TEST_BUILD], { stdio: 'inherit' });
  process.exit(result.status ?? 90);
}
if (process.env.PNPM_TEST_STREAMS) {
  process.stdout.write(fs.readFileSync(0));
  process.stderr.write('underlying diagnostic\\n');
}
process.exit(Number(process.env.PNPM_TEST_EXIT || 0));
`,
    { mode: 0o755 },
  );
  const readEvents = (): {
    args: string[];
    node: string;
    offline: string;
    hooks: string;
    verify: string;
  }[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  return { root, workspace, pnpm, log, readEvents };
}

test('native tool PATH guards raw child and nested build invocations in an ESM workspace', (t) => {
  const f = fixture(t);
  writeFileSync(
    path.join(f.workspace, 'package.json'),
    '{"private":true,"type":"module"}',
  );
  const frozen = readFileSync(path.join(f.workspace, 'package.json'));
  const build = path.join(f.workspace, 'build.cjs');
  writeFileSync(
    build,
    `const result = require('node:child_process').spawnSync('pnpm', ['exec', 'tsc', '--noEmit'], { stdio: 'inherit' }); process.exit(result.status ?? 91);`,
  );
  const { readableToolRoots, toolDirectories } = taskTools(
    f.workspace,
    process.execPath,
    f.pnpm,
  );
  const tools = path.join(f.workspace, '.eval-tmp/limina-tools');
  assert.equal(toolDirectories[0], tools);
  assert.deepEqual(readableToolRoots, [
    path.dirname(process.execPath),
    f.pnpm,
    '/System/Library/OpenSSL',
    tools,
  ]);
  const environment = {
    ...codexEnvironment(
      f.root,
      path.join(f.workspace, '.eval-tmp'),
      toolDirectories,
    ),
    PNPM_TEST_LOG: f.log,
    PNPM_TEST_BUILD: build,
  };
  const baseline = spawnSync(f.pnpm, ['--version'], {
    cwd: f.workspace,
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.deepEqual(f.readEvents()[0]!.args, ['--version']);
  const guarded = spawnSync(
    process.execPath,
    [
      '-e',
      `const result = require('node:child_process').spawnSync('pnpm', ['run', 'build'], { stdio: 'inherit' }); process.exit(result.status ?? 92);`,
    ],
    { cwd: f.workspace, env: environment, encoding: 'utf8' },
  );
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.deepEqual(
    f.readEvents().map((event) => event.args),
    [
      ['--version'],
      [
        'with',
        'current',
        '--config.verify-deps-before-run=false',
        '--config.ignore-scripts=true',
        '--config.offline=true',
        'run',
        'build',
      ],
      [
        'with',
        'current',
        '--config.verify-deps-before-run=false',
        '--config.ignore-scripts=true',
        '--config.offline=true',
        'exec',
        'tsc',
        '--noEmit',
      ],
    ],
  );
  for (const event of f.readEvents().slice(1)) {
    assert.equal(event.node, process.execPath);
    assert.equal(event.offline, 'true');
    assert.equal(event.hooks, 'true');
    assert.equal(event.verify, 'false');
  }
  assert.deepEqual(
    readFileSync(path.join(f.workspace, 'package.json')),
    frozen,
  );
});

test('guard normalizes redundant prefixes and config while preserving command arguments and process streams', (t) => {
  const f = fixture(t);
  const tools = preparePnpmTool(f.workspace, process.execPath, f.pnpm);
  const result = spawnSync(
    path.join(tools, 'pnpm'),
    [
      'with',
      'current',
      'with',
      'current',
      '--config.offline=false',
      '--config.ignore-scripts',
      'false',
      '--no-offline',
      '--verify-deps-before-run=true',
      '-C',
      f.workspace,
      'exec',
      'node',
      '--',
      '--config.offline=false',
      'install',
    ],
    {
      cwd: f.workspace,
      input: 'input reaches the child\n',
      encoding: 'utf8',
      env: {
        PNPM_TEST_LOG: f.log,
        PNPM_TEST_STREAMS: '1',
        PNPM_TEST_EXIT: '17',
        npm_config_offline: 'false',
      },
    },
  );
  assert.equal(result.status, 17, result.stderr);
  assert.equal(result.stdout, 'input reaches the child\n');
  assert.equal(result.stderr, 'underlying diagnostic\n');
  assert.deepEqual(f.readEvents()[0]!.args, [
    'with',
    'current',
    '--config.verify-deps-before-run=false',
    '--config.ignore-scripts=true',
    '--config.offline=true',
    '-C',
    f.workspace,
    'exec',
    'node',
    '--',
    '--config.offline=false',
    'install',
  ]);
  assert.equal(f.readEvents()[0]!.offline, 'true');
});

test('explicit installation commands fail before the underlying executable runs', (t) => {
  const f = fixture(t);
  const tools = preparePnpmTool(f.workspace, process.execPath, f.pnpm);
  for (const commandArguments of [
    ['install'],
    ['with', 'current', 'i'],
    ['--filter', 'consumer', 'add', 'typescript'],
    [`--dir=${f.workspace}`, 'update'],
    ['-C', f.workspace, 'remove', 'typescript'],
    ['dlx', 'typescript'],
    ['fetch'],
    ['rebuild'],
    ['with', 'pnpm@other', 'run', 'build'],
  ]) {
    const result = spawnSync(path.join(tools, 'pnpm'), commandArguments, {
      cwd: f.workspace,
      encoding: 'utf8',
      env: { PNPM_TEST_LOG: f.log },
    });
    assert.equal(
      result.status,
      80,
      JSON.stringify({ commandArguments, ...result }),
    );
    assert.match(result.stderr, /LIMINA_EVAL_PNPM_INSTALL_FORBIDDEN/);
  }
  assert.deepEqual(f.readEvents(), []);
});

test('guard executes a pinned Node path containing spaces and a quote without PATH interpreter selection', (t) => {
  const f = fixture(t);
  const binaries = path.join(f.root, "pinned node's tools");
  mkdirSync(binaries);
  const node = path.join(binaries, 'node');
  linkSync(process.execPath, node);
  const unrelated = path.join(f.root, 'unrelated-tools');
  mkdirSync(unrelated);
  writeFileSync(path.join(unrelated, 'node'), '#!/bin/sh\nexit 99\n', {
    mode: 0o755,
  });
  const tools = preparePnpmTool(f.workspace, node, f.pnpm);
  const result = spawnSync(path.join(tools, 'pnpm'), ['--version'], {
    cwd: f.workspace,
    env: { PNPM_TEST_LOG: f.log, PATH: unrelated },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.readEvents().length, 1);
  assert.deepEqual(f.readEvents()[0]!.args, [
    'with',
    'current',
    '--config.verify-deps-before-run=false',
    '--config.ignore-scripts=true',
    '--config.offline=true',
    '--version',
  ]);
});

test('tool preparation reuses exact read-only bytes and refuses changed bytes or permissions', (t) => {
  const f = fixture(t);
  const directory = preparePnpmTool(f.workspace, process.execPath, f.pnpm);
  const executable = path.join(directory, 'pnpm');
  const before = statSync(executable);
  const source = readFileSync(executable);
  assert.equal(before.mode & 0o777, 0o555);
  assert.equal(
    preparePnpmTool(f.workspace, process.execPath, f.pnpm),
    directory,
  );
  const after = statSync(executable);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  chmodSync(executable, 0o755);
  assert.throws(
    () => preparePnpmTool(f.workspace, process.execPath, f.pnpm),
    /frozen read-only template/,
  );
  assert.equal(statSync(executable).mode & 0o777, 0o755);
  assert.deepEqual(readFileSync(executable), source);
  writeFileSync(executable, 'unrelated tool bytes');
  chmodSync(executable, 0o555);
  assert.throws(
    () => preparePnpmTool(f.workspace, process.execPath, f.pnpm),
    /frozen read-only template/,
  );
  assert.equal(readFileSync(executable, 'utf8'), 'unrelated tool bytes');
});

test('tool preparation refuses workspace and temporary symlink ancestors and existing tool symlinks', (t) => {
  const f = fixture(t);
  const alias = path.join(f.root, 'alias');
  symlinkSync(f.workspace, alias, 'dir');
  assert.throws(
    () => preparePnpmTool(alias, process.execPath, f.pnpm),
    /real directory/,
  );
  assert.equal(existsSync(path.join(f.workspace, '.eval-tmp')), false);
  const outside = path.join(f.root, 'outside');
  mkdirSync(outside);
  const temporary = path.join(f.workspace, '.eval-tmp');
  symlinkSync(outside, temporary, 'dir');
  assert.throws(
    () => preparePnpmTool(f.workspace, process.execPath, f.pnpm),
    /real directory/,
  );
  assert.equal(existsSync(path.join(outside, 'limina-tools')), false);
  rmSync(temporary);
  mkdirSync(path.join(temporary, 'limina-tools'), { recursive: true });
  const existing = path.join(outside, 'original');
  writeFileSync(existing, 'unrelated frozen input');
  symlinkSync(existing, path.join(temporary, 'limina-tools/pnpm'));
  assert.throws(() => preparePnpmTool(f.workspace, process.execPath, f.pnpm));
  assert.equal(readFileSync(existing, 'utf8'), 'unrelated frozen input');
});
