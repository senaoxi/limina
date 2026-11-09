import assert from 'node:assert/strict';
import {
  chmod,
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
import { test } from 'node:test';
import { contentIdentity } from '../core/identity.ts';
import { captureSnapshot, sha256 } from '../core/snapshot.ts';
import { verifyPreparedInputs } from './preflight.ts';
import type { PreparedInputs } from './prepare.ts';

async function fixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-preflight-'));
  const root = await realpath(temporary);
  const directory = path.join(root, 'prepared');
  const source = path.join(directory, 'source');
  await mkdir(path.join(source, 'skills/limina/references'), {
    recursive: true,
  });
  await writeFile(
    path.join(source, 'skills/limina/SKILL.md'),
    'synthetic offline Skill',
  );
  await writeFile(
    path.join(source, 'skills/limina/references/config.md'),
    'reference identity matters',
  );
  await writeFile(path.join(source, 'tracked.ts'), 'export const value = 1;');
  await writeFile(
    path.join(source, 'untracked.bin'),
    Buffer.from([0, 255, 31]),
  );
  const snapshot = await captureSnapshot(source, 'F0');
  const skill = await captureSnapshot(path.join(source, 'skills/limina'), 'F0');
  const files: PreparedInputs['repository']['files'] = snapshot.entries.flatMap(
    (entry) =>
      entry.kind === 'file'
        ? [{ path: entry.path, mode: entry.mode, sha256: entry.sha256 }]
        : [],
  );
  files.push({ path: 'deleted.ts', mode: 0, sha256: null });
  const binary = {
    executable: '/synthetic/tool',
    version: 'offline-fixture',
    sha256: sha256('tool'),
  };
  const artifacts: PreparedInputs['artifacts'] = [];
  for (const name of ['limina', 'limina-migrate'] as const) {
    const content = `opaque offline artifact ${name}`;
    await writeFile(path.join(directory, `${name}.tgz`), content);
    artifacts.push({
      name,
      path: `${name}.tgz`,
      sha256: sha256(content),
      treeDigest: sha256('synthetic tree'),
    });
  }
  const body: Omit<PreparedInputs, 'identity'> = {
    version: 1,
    repository: {
      version: 1,
      head: 'synthetic-head',
      status: 'dirty fixture',
      files,
      contentDigest: contentIdentity(files),
    },
    toolchain: {
      node: binary,
      pnpm: binary,
      storeDirectory: '/synthetic/store',
      registryMetadata: {
        directory: '/synthetic/metadata',
        manifestSha256: sha256('metadata'),
      },
    },
    skillDigest: skill.digest!,
    artifacts,
  };
  async function save() {
    const prepared = { ...body, identity: contentIdentity(body) };
    await writeFile(
      path.join(directory, 'prepared.json'),
      JSON.stringify(prepared),
    );
    return prepared;
  }
  const prepared = await save();
  return { root, directory, source, body, prepared, save };
}

test('preflight rechecks both product bytes and manifest identity before accepting frozen input', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const verified = await verifyPreparedInputs(f.directory);
  assert.equal(verified.identity, f.prepared.identity);
  for (const artifact of f.body.artifacts) {
    const target = path.join(f.directory, artifact.path);
    const original = await readFile(target);
    await writeFile(target, 'replaced artifact');
    await assert.rejects(
      verifyPreparedInputs(f.directory),
      /product artifact changed/,
    );
    await writeFile(target, original);
  }
  await writeFile(
    path.join(f.directory, 'prepared.json'),
    JSON.stringify({ ...f.prepared, skillDigest: sha256('forged') }),
  );
  await assert.rejects(
    verifyPreparedInputs(f.directory),
    /manifest identity mismatch/,
  );
});

test('preflight rejects added, deleted, chmod and Skill-reference drift despite an unchanged Git HEAD', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const reference = path.join(f.source, 'skills/limina/references/config.md');
  const original = await readFile(reference);
  await writeFile(reference, 'changed reference only');
  await assert.rejects(
    verifyPreparedInputs(f.directory),
    /repository bytes or modes changed/,
  );
  await writeFile(reference, original);
  const untracked = path.join(f.source, 'untracked.bin');
  await chmod(untracked, 0o755);
  await assert.rejects(
    verifyPreparedInputs(f.directory),
    /repository bytes or modes changed/,
  );
  await chmod(
    untracked,
    f.body.repository.files.find((file) => file.path === 'untracked.bin')!.mode,
  );
  await writeFile(path.join(f.source, 'deleted.ts'), 'resurrected input');
  await assert.rejects(
    verifyPreparedInputs(f.directory),
    /repository bytes or modes changed/,
  );
  await rm(path.join(f.source, 'deleted.ts'));
  await rm(untracked);
  await assert.rejects(
    verifyPreparedInputs(f.directory),
    /repository bytes or modes changed/,
  );
});

test('preflight rejects external product aliases and traversal even with matching hashes', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const original = f.body.artifacts[0]!;
  const target = path.join(f.directory, original.path);
  const outside = path.join(f.root, 'external.tgz');
  await writeFile(outside, await readFile(target));
  await rm(target);
  await symlink(outside, target);
  await assert.rejects(
    verifyPreparedInputs(f.directory),
    /product artifact changed/,
  );
  f.body.artifacts[0] = { ...original, path: '../external.tgz' };
  await f.save();
  await assert.rejects(verifyPreparedInputs(f.directory), /path/i);
  const alias = path.join(f.root, 'alias');
  await symlink(f.directory, alias);
  await assert.rejects(verifyPreparedInputs(alias), /canonical/);
});
