import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { contentIdentity } from './identity.ts';
import {
  captureSnapshot,
  compareAgentSnapshots,
  verifySnapshot,
} from './snapshot.ts';

test('Agent delta starts after setup and includes ignored files, binary edits and deletions', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'eval-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'source.ts'), 'export const value = 1;');
  const fixture = await captureSnapshot(root, 'F0');
  await writeFile(path.join(root, 'package.json'), '{"private":true}');
  await writeFile(path.join(root, 'deleted.bin'), Buffer.from([0, 255, 4]));
  const start = await captureSnapshot(root, 'S0');
  await writeFile(path.join(root, '.gitignore'), '*');
  await writeFile(path.join(root, 'answer.bin'), Buffer.from([255, 0, 128]));
  await rm(path.join(root, 'deleted.bin'));
  const final = await captureSnapshot(root, 'S1');
  const changes = compareAgentSnapshots(start, final);
  const serialized = JSON.stringify(changes);
  const stored: unknown = JSON.parse(serialized);
  assert.equal(contentIdentity(changes), contentIdentity(stored));
  assert.deepEqual(
    changes.map((entry) => entry.path),
    ['.gitignore', 'answer.bin', 'deleted.bin'],
  );
  assert.throws(() => compareAgentSnapshots(fixture, final), /S0 and S1/);
  assert.equal(
    final.entries.find(
      (entry) => entry.path === 'answer.bin' && entry.kind === 'file',
    )?.kind,
    'file',
  );
  verifySnapshot(final);
});

test('capture loss cannot be interpreted as an empty successful diff', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'eval-capture-loss-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'input.txt'), 'original');
  const start = await captureSnapshot(root, 'S0');
  const limited = await captureSnapshot(root, 'S1', { maxBytes: 1 });
  assert.notEqual(limited.status, 'complete');
  assert.equal(limited.digest, null);
  assert.throws(
    () => compareAgentSnapshots(start, limited),
    /Incomplete snapshot/,
  );
  await rm(root, { recursive: true });
  const destroyed = await captureSnapshot(root, 'S1');
  assert.equal(destroyed.status, 'unknown');
  assert.throws(
    () => compareAgentSnapshots(start, destroyed),
    /Incomplete snapshot/,
  );
});

test('links are recorded without following targets and transmitted content is checked', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'eval-snapshot-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'project'));
  await writeFile(path.join(root, 'secret.txt'), 'outside project');
  await symlink('../secret.txt', path.join(root, 'project', 'link'));
  await writeFile(path.join(root, 'project', 'run.sh'), 'exit 0');
  const start = await captureSnapshot(path.join(root, 'project'), 'S0');
  await chmod(path.join(root, 'project', 'run.sh'), 0o755);
  const final = await captureSnapshot(path.join(root, 'project'), 'S1');
  const link = final.entries.find((entry) => entry.path === 'link');
  assert.ok(link && link.kind === 'symlink');
  assert.equal(link.target, '../secret.txt');
  assert.equal('content' in link, false);
  assert.deepEqual(
    compareAgentSnapshots(start, final).map((entry) => entry.path),
    ['run.sh'],
  );
  const file = final.entries.find((entry) => entry.kind === 'file');
  assert.ok(file && file.kind === 'file');
  file.content = Buffer.from('forged').toString('base64');
  assert.throws(() => verifySnapshot(final), /content mismatch/);
});
