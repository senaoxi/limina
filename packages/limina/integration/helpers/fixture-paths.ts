import path from 'node:path';

import { isPathInsideDirectory } from '../../src/utils/path';

interface PortablePathOptions {
  readonly allowGlob?: boolean;
  readonly label: string;
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;
const GLOB_SYNTAX_PATTERN = /[*?[\]{}()!]/u;

function assertStringPath(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value === 'string' && value.length > 0) return;
  throw new Error(`${label} must be a non-empty string.`);
}

function assertPortableSeparators(value: string, label: string): void {
  if (!value.includes('\\')) return;
  throw new Error(`${label} must use portable "/" separators: ${value}`);
}

function isAbsolutePortablePath(value: string): boolean {
  if (value.includes('\0')) return true;
  if (path.isAbsolute(value)) return true;
  return WINDOWS_ABSOLUTE_PATH_PATTERN.test(value);
}

function assertRelativePath(value: string, label: string): void {
  if (!isAbsolutePortablePath(value)) return;
  throw new Error(`${label} must be a relative portable path: ${value}`);
}

function isInvalidPathSegment(segment: string): boolean {
  if (segment.length === 0) return true;
  if (segment === '.') return true;
  return segment === '..';
}

function assertPathSegments(
  segments: readonly string[],
  options: {
    label: string;
    value: string;
  },
): void {
  if (!segments.some(isInvalidPathSegment)) return;
  throw new Error(
    `${options.label} must not contain empty, ".", or ".." segments: ${options.value}`,
  );
}

function assertNoGlobSyntax(
  segments: readonly string[],
  options: PortablePathOptions & { value: string },
): void {
  if (options.allowGlob === true) return;
  if (!segments.some((segment) => GLOB_SYNTAX_PATTERN.test(segment))) return;
  throw new Error(
    `${options.label} must not contain glob syntax: ${options.value}`,
  );
}

export function validatePortableRelativePath(
  value: unknown,
  options: PortablePathOptions,
): string {
  assertStringPath(value, options.label);
  assertPortableSeparators(value, options.label);
  assertRelativePath(value, options.label);
  const segments = value.split('/');
  assertPathSegments(segments, { label: options.label, value });
  assertNoGlobSyntax(segments, { ...options, value });
  return value;
}

export function resolvePortablePathInside(
  rootDir: string,
  relativePath: string,
  label = 'fixture path',
): string {
  validatePortableRelativePath(relativePath, { label });
  const candidatePath = path.resolve(rootDir, ...relativePath.split('/'));
  if (!isPathInsideDirectory(candidatePath, rootDir)) {
    throw new Error(`${label} escapes its root: ${relativePath}`);
  }
  return candidatePath;
}

export function isPortablePathAtOrBelow(
  candidatePath: string,
  parentPath: string,
): boolean {
  if (candidatePath === parentPath) return true;
  return candidatePath.startsWith(`${parentPath}/`);
}
