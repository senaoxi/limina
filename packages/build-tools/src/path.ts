import fs, { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'pathe';

export function slash(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
Check whether `child` is inside (or equal to) `parent` using path segments.
*/
export function isSubpath(parent: string, child: string): boolean {
  const related = relative(parent, child);
  return related === '' || (!related.startsWith('..') && !isAbsolute(related));
}

const WORKSPACE_ROOT_FILES = ['pnpm-workspace.yaml', 'lerna.json'];

function hasWorkspaceRootFile(direction: string): boolean {
  return WORKSPACE_ROOT_FILES.some((f) => fs.existsSync(join(direction, f)));
}

function hasWorkspacePackageJson(direction: string): boolean {
  const p = join(direction, 'package.json');
  if (!fs.existsSync(p)) return false;
  try {
    const content = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    return Boolean(content.workspaces);
  } catch {
    return false;
  }
}

function hasWorkspaceDenoJson(direction: string): boolean {
  for (const name of ['deno.json', 'deno.jsonc']) {
    const p = join(direction, name);
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

function isWorkspaceRoot(direction: string): boolean {
  return (
    hasWorkspaceRootFile(direction) ||
    hasWorkspacePackageJson(direction) ||
    hasWorkspaceDenoJson(direction)
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
  startDirectory: string,
  cache: Map<string, string | undefined>,
  isMatches: (direction: string) => boolean,
): string | undefined {
  const resolved = realpathSync(startDirectory);
  if (cache.has(resolved)) return cache.get(resolved);

  const visited: string[] = [];
  let direction = resolved;
  while (true) {
    // mid-walk cache hit: every dir we've passed shares the cached answer
    if (cache.has(direction)) {
      const cached = cache.get(direction);
      for (const v of visited) cache.set(v, cached);
      return cached;
    }
    visited.push(direction);

    if (isMatches(direction)) {
      for (const v of visited) cache.set(v, direction);
      return direction;
    }

    const parent = dirname(direction);
    if (parent === direction) {
      // fs root reached without a match — record "no result" for the whole chain
      for (const v of visited) cache.set(v, undefined);
      return undefined;
    }
    direction = parent;
  }
}

const workspaceRootCache: { value: string | undefined | null } = {
  value: null,
};

/**
 * Walks up from `startDir` and returns the first directory matching a workspace
 * marker. Detection list mirrors Vite's `searchForWorkspaceRoot` (searchRoot.ts):
 * pnpm-workspace.yaml, lerna.json, package.json with `workspaces`, or
 * deno.json{c} with `workspace`. A project has at most one workspace root, so
 * the result is cached in a single slot for the process lifetime.
 */
export function findMonorepoRoot(startDirectory: string): string | undefined {
  if (workspaceRootCache.value !== null) return workspaceRootCache.value;

  let direction = realpathSync(startDirectory);
  while (true) {
    if (isWorkspaceRoot(direction)) {
      workspaceRootCache.value = direction;
      return direction;
    }
    const parent = dirname(direction);
    if (parent === direction) {
      workspaceRootCache.value = undefined;
      return undefined;
    }
    direction = parent;
  }
}

/**
 * Walks up from `startDir` and returns the nearest directory containing a
 * `package.json`, or `undefined` if none is found up to the filesystem root.
 * Results are cached per visited directory.
 */
export function findNearestPackageRoot(
  startDirectory: string,
): string | undefined {
  return walkUpWithCache(startDirectory, packageRootCache, (direction) =>
    fs.existsSync(join(direction, 'package.json')),
  );
}

export function getProjectRoot(): string {
  return findNearestPackageRoot(process.cwd()) ?? process.cwd();
}
