import { normalizeAbsolutePath, normalizeSlashes } from '#utils/path';
import path from 'node:path';

export function createFixturePathResolver(
  rootDir: string,
): (...segments: string[]) => string {
  return (...segments) =>
    normalizeAbsolutePath(path.join(rootDir, ...segments));
}

export function toPortablePath(value: string): string {
  return normalizeSlashes(value);
}

export function toPortablePaths(values: readonly string[]): string[] {
  return values.map(toPortablePath);
}

export function toPortableRelativePath(
  rootDir: string,
  absolutePath: string,
): string {
  return toPortablePath(path.relative(rootDir, absolutePath));
}

export function toPortableRelativePaths(
  rootDir: string,
  absolutePaths: readonly string[],
): string[] {
  return absolutePaths.map((absolutePath) =>
    toPortableRelativePath(rootDir, absolutePath),
  );
}
