import { toPosixPath } from '#utils/path';
import path from 'node:path';
import { escapePath } from 'tinyglobby';

const parentDirectoryPattern = /^(?:\/?\.\.)+/u;
const escapingBackslashes = /\\(?=[()[\]{}!*+?@|])/gu;

export interface ProcessedExcludePatterns {
  negative: string[];
  positive: string[];
}

export function normalizeWorkspaceGlob(value: string): string {
  return value.trim();
}

function trimTrailingSlash(pattern: string): string {
  return pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
}

function normalizePatternPath(pattern: string, escapedCwd: string): string {
  const unescapedPattern = pattern.replaceAll(escapingBackslashes, '');

  return path.isAbsolute(unescapedPattern)
    ? path.posix.relative(escapedCwd, pattern)
    : path.posix.normalize(pattern);
}

function canCollapseParentSegment(options: {
  cwdParts: readonly string[];
  matchedParents: number;
  parentCount: number;
  parts: readonly string[];
}): boolean {
  const { cwdParts, matchedParents, parentCount, parts } = options;
  return (
    matchedParents < parentCount &&
    parts[matchedParents + parentCount] ===
      cwdParts[cwdParts.length + matchedParents - parentCount]
  );
}

function collapseParentSegment(options: {
  matchedParents: number;
  matchedPart: string;
  parentCount: number;
  pattern: string;
}): string {
  const { matchedParents, matchedPart, parentCount, pattern } = options;
  const collapsed =
    pattern.slice(0, (parentCount - matchedParents - 1) * 3) +
    pattern.slice((parentCount - matchedParents) * 3 + matchedPart.length + 1);

  return collapsed.length === 0 ? '.' : collapsed;
}

function collapseMatchedParentSegments(
  pattern: string,
  escapedCwd: string,
  parentDirectory: string,
): string {
  const parentCount = (parentDirectory.length + 1) / 3;
  const parts = pattern.split('/');
  const cwdParts = escapedCwd.split('/');
  let matchedParents = 0;
  let result = pattern;

  while (
    canCollapseParentSegment({
      cwdParts,
      matchedParents,
      parentCount,
      parts,
    })
  ) {
    result = collapseParentSegment({
      matchedParents,
      matchedPart: parts[matchedParents + parentCount]!,
      parentCount,
      pattern: result,
    });
    matchedParents += 1;
  }

  return result;
}

export function normalizeTinyglobbyPattern(
  pattern: string,
  cwd: string,
): string {
  const escapedCwd = escapePath(toPosixPath(cwd));
  const normalized = normalizePatternPath(
    trimTrailingSlash(pattern),
    escapedCwd,
  );
  const parentDirectory = parentDirectoryPattern.exec(normalized)?.[0];

  return parentDirectory === undefined
    ? normalized
    : collapseMatchedParentSegments(normalized, escapedCwd, parentDirectory);
}

export function expandTinyglobbyPattern(pattern: string): string[] {
  if (!pattern || pattern.endsWith('*')) {
    return [pattern];
  }

  return [pattern, `${pattern}/**`];
}

function isPositiveExcludePattern(pattern: string): boolean {
  return pattern[0] !== '!' || pattern[1] === '(';
}

function isNegativeExcludePattern(pattern: string): boolean {
  return pattern[1] !== '!' || pattern[2] === '(';
}

function appendExcludePattern(
  processed: ProcessedExcludePatterns,
  rootDir: string,
  pattern: string,
): void {
  if (isPositiveExcludePattern(pattern)) {
    processed.positive.push(
      ...expandTinyglobbyPattern(normalizeTinyglobbyPattern(pattern, rootDir)),
    );
    return;
  }

  if (isNegativeExcludePattern(pattern)) {
    processed.negative.push(
      ...expandTinyglobbyPattern(
        normalizeTinyglobbyPattern(pattern.slice(1), rootDir),
      ),
    );
  }
}

export function processExcludePatterns(
  rootDir: string,
  patterns: readonly string[],
): ProcessedExcludePatterns {
  const processed: ProcessedExcludePatterns = {
    negative: [],
    positive: [],
  };

  for (const value of patterns) {
    const pattern = normalizeWorkspaceGlob(value);

    if (pattern.length > 0) {
      appendExcludePattern(processed, rootDir, pattern);
    }
  }

  return processed;
}
