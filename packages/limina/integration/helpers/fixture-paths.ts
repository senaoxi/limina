import path from 'node:path';

import { isPathInsideDirectory } from '../../src/utils/path';

interface PortablePathOptions {
  readonly allowGlob?: boolean;
  readonly label: string;
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;

export function validatePortableRelativePath(
  value: unknown,
  options: PortablePathOptions,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${options.label} must be a non-empty string.`);
  }
  if (value.includes('\\')) {
    throw new Error(
      `${options.label} must use portable "/" separators: ${value}`,
    );
  }
  if (
    value.includes('\0') ||
    path.isAbsolute(value) ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)
  ) {
    throw new Error(
      `${options.label} must be a relative portable path: ${value}`,
    );
  }

  const segments = value.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw new Error(
      `${options.label} must not contain empty, ".", or ".." segments: ${value}`,
    );
  }
  if (
    !options.allowGlob &&
    segments.some((segment) => /[*?[\]{}()!]/u.test(segment))
  ) {
    throw new Error(`${options.label} must not contain glob syntax: ${value}`);
  }

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
  return (
    candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`)
  );
}
