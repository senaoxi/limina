import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
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
import { test } from 'node:test';
import { promisify } from 'node:util';
import { freezeRepo } from './prepare.ts';

const exec = promisify(execFile);
async function fixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-freeze-'));
  const root = await realpath(temporary);
  const repo = path.join(root, 'repository');
  await mkdir(repo);
  const git = (...arguments_: string[]) =>
    exec('/usr/bin/git', ['-C', repo, ...arguments_], {
      env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
    });
  await git('init', '--quiet');
  await writeFile(path.join(repo, 'tracked.txt'), 'committed');
  await writeFile(path.join(repo, 'deleted.txt'), 'remove me');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  return { root, repository: repo };
}

test('freezes actual dirty and untracked bytes, deletion and modes independently of HEAD', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(path.join(f.repository, 'tracked.txt'), 'uncommitted');
  await chmod(path.join(f.repository, 'tracked.txt'), 0o755);
  await writeFile(
    path.join(f.repository, 'untracked.bin'),
    Buffer.from([0, 255, 3]),
  );
  await rm(path.join(f.repository, 'deleted.txt'));
  const destination = path.join(f.root, 'frozen');
  const frozen = await freezeRepo(f.repository, destination);
  assert.equal(
    await readFile(path.join(destination, 'tracked.txt'), 'utf8'),
    'uncommitted',
  );
  const trackedStatus = await stat(path.join(destination, 'tracked.txt'));
  assert.equal(trackedStatus.mode & 0o777, 0o755);
  assert.deepEqual(
    await readFile(path.join(destination, 'untracked.bin')),
    Buffer.from([0, 255, 3]),
  );
  assert.equal(
    frozen.files.find((file) => file.path === 'deleted.txt')?.sha256,
    null,
  );
  await assert.rejects(stat(path.join(destination, 'deleted.txt')), {
    code: 'ENOENT',
  });
  await writeFile(path.join(f.repository, 'tracked.txt'), 'second edit');
  const second = await freezeRepo(f.repository, path.join(f.root, 'second'));
  assert.equal(second.head, frozen.head);
  assert.notEqual(second.contentDigest, frozen.contentDigest);
  assert.equal(
    await readFile(path.join(destination, 'tracked.txt'), 'utf8'),
    'uncommitted',
  );
});

test('rejects output inside checkout through lexical and symlink aliases before creating it', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const alias = path.join(f.root, 'alias');
  await symlink(f.repository, alias);
  for (const destination of [
    path.join(f.repository, 'output'),
    path.join(alias, 'output'),
    `${f.root}/repository/../repository/output`,
  ]) {
    await assert.rejects(
      freezeRepo(f.repository, destination),
      /outside the source checkout/,
    );
    await assert.rejects(stat(path.join(f.repository, 'output')), {
      code: 'ENOENT',
    });
  }
});

test('rejects repository symlinks instead of following an external input', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(path.join(f.root, 'external'), 'not a repository input');
  await symlink(path.join(f.root, 'external'), path.join(f.repository, 'link'));
  await assert.rejects(
    freezeRepo(f.repository, path.join(f.root, 'output')),
    /not a regular file/,
  );
});
