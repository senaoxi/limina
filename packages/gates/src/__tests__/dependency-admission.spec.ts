import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { satisfies } from 'semver';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

interface DependencyReferences {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface Lockfile {
  packages: Record<string, unknown>;
  snapshots: Record<string, DependencyReferences>;
  importers: Record<
    string,
    Record<string, Record<string, { version: string }>>
  >;
}

const allowedZod3Owners = new Set([
  '@vercel/backends@22.0.1',
  '@vercel/express@22.0.1',
  '@vercel/hono@22.0.1',
  '@vercel/python-analysis@0.15.2',
]);

function isZod3Reference(name: string, reference: string): boolean {
  if (name !== 'zod' && !reference.startsWith('zod@')) return false;
  const version = reference.replace(/^zod@/u, '').split('(', 1)[0]!;
  return satisfies(version, '>=3.0.0 <4.0.0');
}

function assertZodExceptionBoundary(lockfile: Lockfile): void {
  const versions = Object.keys(lockfile.packages)
    .filter((name) => name.startsWith('zod@'))
    .map((name) => name.slice('zod@'.length));
  if (!versions.includes('3.22.4'))
    throw new Error('Remove the obsolete Zod 3 audit exception.');
  for (const version of versions) {
    if (version !== '3.22.4' && !satisfies(version, '>=4.6.7'))
      throw new Error(`Unreviewed or unpatched Zod version: ${version}`);
  }
  for (const [owner, snapshot] of Object.entries(lockfile.snapshots)) {
    const dependencies = {
      ...snapshot.dependencies,
      ...snapshot.optionalDependencies,
    };
    for (const [name, reference] of Object.entries(dependencies)) {
      if (
        isZod3Reference(name, reference) &&
        !allowedZod3Owners.has(owner.split('(', 1)[0]!)
      )
        throw new Error(`Unreviewed Zod 3 consumer: ${owner}`);
    }
  }
  // Propagate the exception through the real graph, including aliases and peers.
  const reachesZod3 = new Set<string>();
  let hasChanges = true;
  while (hasChanges) {
    hasChanges = false;
    for (const [owner, snapshot] of Object.entries(lockfile.snapshots)) {
      if (reachesZod3.has(owner)) continue;
      const dependencies = {
        ...snapshot.dependencies,
        ...snapshot.optionalDependencies,
      };
      if (
        Object.entries(dependencies).every(
          ([name, reference]) =>
            !(
              isZod3Reference(name, reference) ||
              reachesZod3.has(
                Object.hasOwn(lockfile.snapshots, reference)
                  ? reference
                  : `${name}@${reference}`,
              )
            ),
        )
      ) {
        continue;
      }

      reachesZod3.add(owner);
      hasChanges = true;
    }
  }
  for (const [owner, importer] of Object.entries(lockfile.importers)) {
    for (const [groupName, group] of Object.entries(importer)) {
      for (const [name, reference] of Object.entries(group)) {
        if (isZod3Reference(name, reference.version))
          throw new Error(`Direct Zod 3 dependency: ${owner}`);
        const target = Object.hasOwn(lockfile.snapshots, reference.version)
          ? reference.version
          : `${name}@${reference.version}`;
        if (
          reachesZod3.has(target) &&
          !(
            owner === 'docs' &&
            groupName === 'devDependencies' &&
            name === 'vercel'
          )
        )
          throw new Error(
            `Zod 3 reachable outside the docs Vercel toolchain: ${owner}`,
          );
      }
    }
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

describe('Zod audit exception boundary', () => {
  it('keeps unpatched native distributions out of the resolved graph', () => {
    expect(
      Object.keys(readLockfile().packages).filter((name) =>
        name.startsWith('@vercel/vc-native-'),
      ),
    ).toEqual([]);
  });

  it('confines the approved version to reviewed Vercel builders', () => {
    expect(() => assertZodExceptionBoundary(readLockfile())).not.toThrow();
  });

  it('rejects a new vulnerable version or a Zod 4 rollback', () => {
    for (const version of ['3.25.76', '4.6.5']) {
      const lockfile = readLockfile();
      lockfile.packages[`zod@${version}`] = {};
      expect(() => assertZodExceptionBoundary(lockfile)).toThrow(
        'Unreviewed or unpatched Zod version',
      );
    }
  });

  it('rejects an additional consumer even when the version is unchanged', () => {
    const lockfile = readLockfile();
    lockfile.snapshots['unreviewed-consumer@1.0.0'] = {
      dependencies: { zod: '3.22.4' },
    };
    expect(() => assertZodExceptionBoundary(lockfile)).toThrow(
      'Unreviewed Zod 3 consumer',
    );
  });

  it('rejects a direct workspace dependency on the unpatched API line', () => {
    const lockfile = readLockfile();
    lockfile.importers['.']!.dependencies = {
      zod: { version: '3.22.4' },
    };
    expect(() => assertZodExceptionBoundary(lockfile)).toThrow(
      'Direct Zod 3 dependency',
    );
  });

  it('rejects a product dependency that reaches an otherwise approved builder', () => {
    const lockfile = readLockfile();
    lockfile.importers['packages/limina']!.dependencies!.vercel =
      lockfile.importers.docs!.devDependencies!.vercel!;
    expect(() => assertZodExceptionBoundary(lockfile)).toThrow(
      'Zod 3 reachable outside the docs Vercel toolchain',
    );
  });

  it('requires removal when the unpatched version is no longer installed', () => {
    const lockfile = readLockfile();
    delete lockfile.packages['zod@3.22.4'];
    expect(() => assertZodExceptionBoundary(lockfile)).toThrow(
      'Remove the obsolete Zod 3 audit exception',
    );
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
