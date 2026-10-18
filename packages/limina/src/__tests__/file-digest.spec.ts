import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureConfigDependencyIdentity } from '../typecheck/managed/identity';
import { digestFile } from '../utils/file-digest';
import { createFixturePathResolver } from './helpers/path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-file-digest-'));
  const root = realpathSync.native(temporary);
  roots.push(root);
  return createFixturePathResolver(root);
}

describe('bounded file hashing', () => {
  it.each([0, 1, 4095, 4096, 262_143, 262_144, 262_145, 1_048_593])(
    'hashes all %i binary bytes including the final partial read',
    (length) => {
      const file = fixture()('input.bin');
      const bytes = Buffer.from(
        Array.from({ length }, (_, index) => index % 251),
      );
      writeFileSync(file, bytes);
      expect(digestFile(file)).toEqual({
        hash: createHash('sha256').update(bytes).digest('hex'),
        length,
      });
    },
  );

  it('retains byte-sensitive identities with unchanged size and mtime', () => {
    const file = fixture()('command');
    writeFileSync(file, Buffer.alloc(131_073, 1));
    const before = statSync(file);
    const first = captureConfigDependencyIdentity(file);
    const changed = Buffer.alloc(131_073, 1);
    changed[changed.length - 1] = 2;
    writeFileSync(file, changed);
    utimesSync(file, before.atime, before.mtime);
    const second = captureConfigDependencyIdentity(file);
    expect(second.hash).not.toBe(first.hash);
    expect(second).toEqual({ ...first, hash: second.hash });
    expect(second.length).toBe(changed.length);
  });

  it('retains link identities and rereads a changed symlink target', () => {
    const file = fixture();
    writeFileSync(file('first'), Buffer.alloc(65_537, 1));
    writeFileSync(file('second'), Buffer.alloc(65_537, 2));
    linkSync(file('first'), file('hardlink'));
    expect(captureConfigDependencyIdentity(file('first')).nlink).toBe(2);
    symlinkSync(file('first'), file('link'), 'file');
    const first = captureConfigDependencyIdentity(file('link'));
    expect(first.kind).toBe('symlink');
    expect(first.targetHash).toBe(digestFile(file('first')).hash);
    expect(first.targetLength).toBe(65_537);
    expect(first.targetNlink).toBe(2);
    rmSync(file('link'));
    symlinkSync(file('second'), file('link'), 'file');
    const second = captureConfigDependencyIdentity(file('link'));
    expect(second.canonicalPath).toBe(file('second'));
    expect(second.targetHash).not.toBe(first.targetHash);
    expect(second.targetHash).toBe(digestFile(file('second')).hash);
  });
});
