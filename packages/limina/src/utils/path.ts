import { isAbsolute, normalize, relative, resolve } from 'pathe';

export function toPosixPath(value: string): string {
  return normalizeSlashes(value);
}

export function normalizeAbsolutePath(value: string): string {
  return resolve(value);
}

export function toRelativePath(rootDir: string, absolutePath: string): string {
  const relativePath = relative(rootDir, resolve(absolutePath));

  return relativePath.length === 0 ? '.' : relativePath;
}

export function normalizeSlashes(value: string): string {
  return value.replaceAll('\\', '/');
}

export function normalizeAbsolutePathIdentity(value: string): string {
  const normalizedPath = normalize(value);

  return normalizedPath.length > 1 && !/^[A-Za-z]:\/$/u.test(normalizedPath)
    ? normalizedPath.replace(/\/+$/u, '')
    : normalizedPath;
}

export function isPathInsideDirectory(
  filePath: string,
  directoryPath: string,
): boolean {
  const normalizedFilePath = normalizeComparableAbsolutePath(filePath);
  const normalizedDirectoryPath =
    normalizeComparableAbsolutePath(directoryPath);
  const relativePath = relative(normalizedDirectoryPath, normalizedFilePath);

  return (
    relativePath.length === 0 ||
    (relativePath !== '..' &&
      !relativePath.startsWith('../') &&
      !isAbsolute(relativePath))
  );
}

function normalizeComparableAbsolutePath(value: string): string {
  return normalizeAbsolutePathIdentity(
    isAbsolute(value) ? value : resolve(value),
  );
}
