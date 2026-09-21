import path from 'pathe';
import picomatch from 'picomatch';
import { isDynamicPattern } from 'tinyglobby';
import type { WorkspacePackageGlobGroup } from './selection-policy';

function splitNpmPattern(pattern: string): {
  pattern: string;
  negative: boolean;
} {
  const prefix = /^!+/u.exec(pattern)?.[0] ?? '';
  return {
    pattern: pattern.slice(prefix.length).replace(/^\.?\/+/u, ''),
    negative: prefix.length % 2 === 1,
  };
}

/** npm removes earlier exclusions matched by a later positive declaration. */
export function npmPackageGlobs(globs: readonly string[]): string[] {
  const positive: string[] = [];
  let negative: string[] = [];
  for (const input of globs) {
    const entry = splitNpmPattern(input);
    if (entry.negative) {
      negative.push(entry.pattern);
    } else {
      negative = negative.filter(
        (pattern) => !picomatch(pattern)(entry.pattern),
      );
      positive.push(entry.pattern);
    }
  }
  return [...positive, ...negative.map((pattern) => `!${pattern}`)];
}

function bunExclusion(pattern: string): string {
  // Bun's trailing globstar excludes descendants, not the directory itself.
  return pattern.endsWith('/**') ? `${pattern}/*` : pattern;
}

/** Bun applies exclusions in declaration order; later positives can re-enter. */
export function bunPackageGlobGroups(globs: readonly string[]): string[][] {
  const groups: string[][] = [];
  for (const pattern of globs) {
    addBunPattern(groups, pattern);
  }
  return groups;
}

function isHiddenSegment(segment: string): boolean {
  if (segment === '.' || segment === '..') return false;
  return segment.startsWith('.');
}

function isBunVisiblePattern(pattern: string): boolean {
  if (!isDynamicPattern(pattern)) return true;
  return !pattern.split('/').some(isHiddenSegment);
}

function addBunPattern(groups: string[][], pattern: string): void {
  if (pattern.startsWith('!')) {
    appendBunExclusion(groups, pattern);
    return;
  }
  if (isBunVisiblePattern(pattern)) groups.push([pattern]);
}

/** Exact package exclusions need not cut traversal of child packages. */
export function nonPruningGlobGroup(
  patterns: readonly string[],
  rootDir: string,
): WorkspacePackageGlobGroup {
  const excludes = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => normalizeDirectoryPattern(pattern.slice(1), rootDir));
  const excluded = picomatch(excludes);
  return {
    packageGlobs: patterns.filter((pattern) => !pattern.startsWith('!')),
    acceptsDirectory: (directory) => !excluded(directory),
  };
}

function normalizeDirectoryPattern(pattern: string, rootDir: string): string {
  const relative = path.isAbsolute(pattern)
    ? path.relative(rootDir, pattern)
    : pattern;
  return relative.replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '');
}

function appendBunExclusion(groups: string[][], pattern: string): void {
  for (const group of groups.filter((entry) => isDynamicPattern(entry[0]!))) {
    group.push(bunExclusion(pattern));
  }
}
