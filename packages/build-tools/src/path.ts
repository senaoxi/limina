import fs, { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'pathe';

export function slash(p: string): string {
  return p.replaceAll('\\', '/');
}

/** Check whether `child` is inside (or equal to) `parent` using path segments. */
export function isSubpath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const WORKSPACE_ROOT_FILES = ['pnpm-workspace.yaml', 'lerna.json'];

function hasWorkspaceRootFile(dir: string): boolean {
  return WORKSPACE_ROOT_FILES.some((f) => fs.existsSync(join(dir, f)));
}

function hasWorkspacePackageJson(dir: string): boolean {
  const p = join(dir, 'package.json');
  if (!fs.existsSync(p)) return false;
  try {
    const content = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    return Boolean(content.workspaces);
  } catch {
    return false;
  }
}

function hasWorkspaceDenoJson(dir: string): boolean {
  for (const name of ['deno.json', 'deno.jsonc']) {
    const p = join(dir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const content = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
      if (content.workspace) return true;
    } catch {
      // deno.jsonc with comments — Vite intentionally skips these
    }
  }
  return false;
}

function isWorkspaceRoot(dir: string): boolean {
  return (
    hasWorkspaceRootFile(dir) ||
    hasWorkspacePackageJson(dir) ||
    hasWorkspaceDenoJson(dir)
  );
}

const packageRootCache = new Map<string, string | undefined>();

/**
 * Walks `startDir` upward and returns the first directory satisfying `matches`,
 * or `undefined` if the filesystem root is reached without a hit. Every path
 * visited during the walk is recorded in `cache` with the resulting answer, so
 * subsequent queries starting anywhere along that chain are O(1).
 */
function walkUpWithCache(
  startDir: string,
  cache: Map<string, string | undefined>,
  matches: (dir: string) => boolean,
): string | undefined {
  const resolved = realpathSync(startDir);
  if (cache.has(resolved)) return cache.get(resolved);

  const visited: string[] = [];
  let dir = resolved;
  while (true) {
    // mid-walk cache hit: every dir we've passed shares the cached answer
    if (cache.has(dir)) {
      const cached = cache.get(dir);
      for (const v of visited) cache.set(v, cached);
      return cached;
    }
    visited.push(dir);

    if (matches(dir)) {
      for (const v of visited) cache.set(v, dir);
      return dir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      // fs root reached without a match — record "no result" for the whole chain
      for (const v of visited) cache.set(v, undefined);
      return undefined;
    }
    dir = parent;
  }
}

let monorepoRoot: string | undefined | null = null;

/**
 * Walks up from `startDir` and returns the first directory matching a workspace
 * marker. Detection list mirrors Vite's `searchForWorkspaceRoot` (searchRoot.ts):
 * pnpm-workspace.yaml, lerna.json, package.json with `workspaces`, or
 * deno.json{c} with `workspace`. A project has at most one workspace root, so
 * the result is cached in a single slot for the process lifetime.
 */
export function findMonorepoRoot(startDir: string): string | undefined {
  if (monorepoRoot !== null) return monorepoRoot;

  let dir = realpathSync(startDir);
  while (true) {
    if (isWorkspaceRoot(dir)) {
      monorepoRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      monorepoRoot = undefined;
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Walks up from `startDir` and returns the nearest directory containing a
 * `package.json`, or `undefined` if none is found up to the filesystem root.
 * Results are cached per visited directory.
 */
export function findNearestPackageRoot(startDir: string): string | undefined {
  return walkUpWithCache(startDir, packageRootCache, (dir) =>
    fs.existsSync(join(dir, 'package.json')),
  );
}

export function getProjectRoot(): string {
  return findNearestPackageRoot(process.cwd()) ?? process.cwd();
}
