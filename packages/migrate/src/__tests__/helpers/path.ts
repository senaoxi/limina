import { normalizeAbsolutePath } from 'limina/internal/utils/path';
import path from 'node:path';

export function createFixturePathResolver(
  rootDirectory: string,
): (...segments: string[]) => string {
  return (...segments) =>
    normalizeAbsolutePath(path.join(rootDirectory, ...segments));
}

export function toPortablePath(value: string): string {
  return value.replaceAll('\\', '/');
}

export function toPortablePaths(values: readonly string[]): string[] {
  return values.map(toPortablePath);
}

export function toPortableRelativePath(
  rootDirectory: string,
  absolutePath: string,
): string {
  return toPortablePath(path.relative(rootDirectory, absolutePath));
}

export function toPortableRelativePaths(
  rootDirectory: string,
  absolutePaths: readonly string[],
): string[] {
  return absolutePaths.map((absolutePath) =>
    toPortableRelativePath(rootDirectory, absolutePath),
  );
}
