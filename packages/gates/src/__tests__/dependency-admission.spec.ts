import { readFileSync } from 'node:fs';
import { satisfies } from 'semver';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

interface Lockfile {
  packages: Record<string, unknown>;
}

function assertReviewedZodVersions(lockfile: Lockfile): void {
  for (const name of Object.keys(lockfile.packages)) {
    if (!name.startsWith('zod@')) continue;
    const version = name.slice('zod@'.length);
    if (!satisfies(version, '>=4.6.7'))
      throw new Error(`Zod version below the reviewed minimum: ${version}`);
  }
}

function readLockfile(): Lockfile {
  return parseAllDocuments(
    readFileSync(
      new URL('../../../../pnpm-lock.yaml', import.meta.url),
      'utf8',
    ),
  )
    .at(-1)!
    .toJS() as Lockfile;
}

describe('resolved Zod security minimum', () => {
  it('keeps resolved dependencies at or above the reviewed minimum', () => {
    expect(() => assertReviewedZodVersions(readLockfile())).not.toThrow();
  });

  it('rejects reintroduced Zod 3 and a Zod 4 rollback', () => {
    for (const version of ['3.22.4', '4.6.6']) {
      const lockfile = readLockfile();
      lockfile.packages[`zod@${version}`] = {};
      expect(() => assertReviewedZodVersions(lockfile)).toThrow(
        `Zod version below the reviewed minimum: ${version}`,
      );
    }
  });

  it('allows removal without requiring a legacy version or audit exception', () => {
    const lockfile = readLockfile();
    for (const name of Object.keys(lockfile.packages)) {
      if (name.startsWith('zod@')) delete lockfile.packages[name];
    }
    expect(() => assertReviewedZodVersions(lockfile)).not.toThrow();
  });
});
