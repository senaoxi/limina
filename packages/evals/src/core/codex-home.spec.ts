import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { codexEnvironment, prepareCodexHome } from '../runner/local-codex.ts';

test('isolated Codex home delegates only auth and never follows host instructions or config', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-codex-home-'));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = path.join(root, 'host');
  const client = path.join(root, 'client');
  await mkdir(path.join(host, '.codex'), { recursive: true });
  await mkdir(client);
  const auth = path.join(host, '.codex/auth.json');
  await writeFile(auth, 'SYNTHETIC_AUTH_NOT_A_TOKEN', { mode: 0o600 });
  await writeFile(path.join(host, '.codex/AGENTS.md'), 'HOST_CANARY');
  await writeFile(
    path.join(host, '.codex/config.toml'),
    'user_instructions="HOST_CANARY"',
  );
  const environment = codexEnvironment(host, client, [], client);
  const session = prepareCodexHome(host, environment);
  assert.notEqual(environment.CODEX_HOME, path.join(host, '.codex'));
  assert.deepEqual(await readdir(environment.CODEX_HOME!), ['auth.json']);
  assert.equal(
    await readFile(path.join(environment.CODEX_HOME!, 'auth.json'), 'utf8'),
    'SYNTHETIC_AUTH_NOT_A_TOKEN',
  );
  await writeFile(
    path.join(environment.CODEX_HOME!, 'AGENTS.override.md'),
    'INJECTED',
  );
  assert.throws(() => session.assertClean(), /Unexpected instructions/);
  await unlink(path.join(environment.CODEX_HOME!, 'AGENTS.override.md'));
  session.assertClean();
  session.dispose();
  assert.equal(await readFile(auth, 'utf8'), 'SYNTHETIC_AUTH_NOT_A_TOKEN');
  assert.deepEqual(await readdir(environment.CODEX_HOME!), []);
});

test('changed credential delegate is rejected and cleanup cannot remove its replacement target', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-codex-delegate-'));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = path.join(root, 'host');
  const client = path.join(root, 'client');
  await mkdir(path.join(host, '.codex'), { recursive: true });
  await mkdir(client);
  await writeFile(path.join(host, '.codex/auth.json'), 'SYNTHETIC_AUTH', {
    mode: 0o600,
  });
  const external = path.join(root, 'external.txt');
  await writeFile(external, 'KEEP');
  const environment = codexEnvironment(host, client, [], client);
  const session = prepareCodexHome(host, environment);
  const delegate = path.join(environment.CODEX_HOME!, 'auth.json');
  await unlink(delegate);
  await symlink(external, delegate);
  assert.throws(() => session.assertClean(), /delegate changed/);
  session.dispose();
  assert.equal(await readFile(external, 'utf8'), 'KEEP');
  assert.equal(
    await readFile(path.join(host, '.codex/auth.json'), 'utf8'),
    'SYNTHETIC_AUTH',
  );
});
