import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { digest, hashObject, invariant, sha } from './io.ts';

export function git(arguments_: string[], cwd = process.cwd()): Buffer {
  return execFileSync('git', arguments_, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
}
export function gitText(arguments_: string[], cwd?: string): string {
  return git(arguments_, cwd).toString('utf8').trim();
}
export function nul(buffer: Buffer): string[] {
  if (buffer.length === 0) return [];
  invariant(buffer.at(-1) === 0, 'Truncated NUL-delimited Git output');
  const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  return value.slice(0, -1).split('\0');
}
export function isAncestor(
  base: string,
  target: string,
  cwd?: string,
): boolean {
  sha(base);
  sha(target);
  try {
    git(['merge-base', '--is-ancestor', base, target], cwd);
    return true;
  } catch {
    return false;
  }
}
export function assertHead(target: string): void {
  invariant(
    gitText(['rev-parse', 'HEAD']) === sha(target),
    'Checkout HEAD does not equal planned target',
  );
}
export function parseDiff(buffer: Buffer): string[] {
  const fields = nul(buffer);
  invariant(fields.length % 2 === 0, 'Malformed Git name-status output');
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    invariant(
      ['A', 'M', 'D'].includes(fields[index]!),
      'Unsupported Git change kind',
    );
    const name = fields[index + 1]!;
    invariant(
      name.length > 0 &&
        !name.startsWith('/') &&
        !name.split('/').includes('..'),
      'Invalid Git path',
    );
    paths.push(name);
  }
  invariant(new Set(paths).size === paths.length, 'Duplicate Git path');
  return paths.sort((left, right) =>
    left < right ? -1 : Number(left > right),
  );
}
export function treeEntries(
  target: string,
  cwd?: string,
): { mode: string; type: string; path: string }[] {
  return nul(git(['ls-tree', '-r', '-t', '-z', sha(target)], cwd)).map(
    (entry) => {
      const tab = entry.indexOf('\t');
      invariant(tab > 0, 'Malformed Git tree');
      const [mode, type] = entry.slice(0, tab).split(' ', 2);
      invariant(mode && type, 'Malformed Git tree mode');
      return { mode, type, path: entry.slice(tab + 1) };
    },
  );
}
export function diff(
  base: string,
  target: string,
  cwd?: string,
): { paths: string[]; diffDigest: string } {
  invariant(isAncestor(base, target, cwd), 'Untrusted diff ancestry');
  const bytes = git(
    [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-status',
      '-z',
      sha(base),
      sha(target),
      '--',
    ],
    cwd,
  );
  const paths = parseDiff(bytes);
  invariant(
    paths.length <= 1000 && JSON.stringify(paths).length * 2 <= 32 * 1024,
    'Diff exceeds bounded classification budget',
  );
  const before = treeEntries(base, cwd);
  const after = treeEntries(target, cwd);
  const directories = new Set(
    before.filter((entry) => entry.type === 'tree').map((entry) => entry.path),
  );
  const changed = new Set(paths);
  invariant(
    [...before, ...after].every(
      (entry) =>
        !(
          changed.has(entry.path) &&
          (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))
        ),
    ),
    'Special Git entry requires full CI',
  );
  for (const name of paths) {
    const parts = name.split('/');
    parts.pop();
    while (parts.length > 0) {
      invariant(
        directories.has(parts.join('/')),
        'New directory requires full CI',
      );
      parts.pop();
    }
  }
  return { paths, diffDigest: digest(bytes) };
}
export function contractHash(target: string, rollingNode: string): string {
  const paths = nul(git(['ls-tree', '-r', '--name-only', '-z', sha(target)]));
  const controls = paths.filter(
    (name) =>
      name.startsWith('.github/') ||
      name.startsWith('packages/gates/src/ci/') ||
      /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.jsonc?)$/.test(
        name,
      ) ||
      /(?:^|\/)[^/]*\.config\.[^/]+$/.test(name) ||
      name.startsWith('scripts/') ||
      [
        'packages/limina/packagePlugin.ts',
        'packages/migrate/packagePlugin.ts',
      ].includes(name),
  );
  return hashObject({
    version: 1,
    rollingNode,
    files: controls.map((name) => [
      name,
      digest(git(['show', target + ':' + name])),
    ]),
  });
}
export function lockHash(): string {
  return digest(readFileSync('pnpm-lock.yaml'));
}
export function prBase(
  target: string,
  head: unknown,
  base: unknown,
): string | undefined {
  const parents = gitText(['show', '-s', '--format=%P', sha(target)]).split(
    ' ',
  );
  return parents.length === 2 && parents[0] === base && parents[1] === head
    ? parents[0]
    : undefined;
}
