import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

interface GuardSchema {
  max(limit: number): GuardSchema;
  length(limit: number): GuardSchema;
  check(check: unknown): GuardSchema;
  transform(callback: (value: string) => string): GuardSchema;
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

interface CliZod {
  core_exports: { version: { major: number; minor: number; patch: number } };
  string(): GuardSchema;
  array(item: GuardSchema): GuardSchema;
  set(item: GuardSchema): GuardSchema;
  map(key: GuardSchema, value: GuardSchema): GuardSchema;
  _maxSize(limit: number): unknown;
}

describe('installed Vercel Zod distribution', () => {
  it('uses patched Zod 4 and rejects oversized containers before visiting items', async () => {
    // Audit ignores cannot see bundled code. Exercise the installed CLI artifact.
    const cli = path.dirname(
      realpathSync(
        new URL(
          '../../../../docs/node_modules/vercel/package.json',
          import.meta.url,
        ),
      ),
    );
    const z = (await import(
      pathToFileURL(path.join(cli, 'dist/chunks/chunk-2NABMKFV.js')).href
    )) as CliZod;
    const { major, minor, patch } = z.core_exports.version;
    expect(satisfies(`${major}.${minor}.${patch}`, '>=4.6.7')).toBe(true);
    for (const kind of ['array-max', 'array-length', 'set-max', 'map-max']) {
      let visited = 0;
      const item = z.string().transform((value) => {
        visited++;
        return value;
      });
      const schema =
        kind === 'array-max'
          ? z.array(item).max(1)
          : kind === 'array-length'
            ? z.array(item).length(1)
            : kind === 'set-max'
              ? z.set(item).max(1)
              : z.map(z.string(), item).check(z._maxSize(1));
      const input =
        kind === 'set-max'
          ? new Set(['a', 'b', 'c'])
          : kind === 'map-max'
            ? new Map([
                ['a', 'a'],
                ['b', 'b'],
                ['c', 'c'],
              ])
            : ['a', 'b', 'c'];
      expect(schema.safeParse(input).success, kind).toBe(false);
      expect(visited, kind).toBe(0);
      const allowed =
        kind === 'set-max'
          ? new Set(['a'])
          : kind === 'map-max'
            ? new Map([['a', 'a']])
            : ['a'];
      expect(schema.safeParse(allowed).success, kind).toBe(true);
      expect(visited, kind).toBe(1);
    }
  });
});
