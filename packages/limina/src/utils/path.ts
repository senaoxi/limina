import { normalize, relative, resolve } from 'pathe';

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

export function toAbsolutePath(rootDir: string, workspacePath: string): string {
  return resolve(rootDir, workspacePath);
}

export function normalizeWorkspacePath(rootDir: string, value: string): string {
  return toRelativePath(rootDir, value);
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
  const normalizedFilePath = normalizeAbsolutePath(filePath);
  const normalizedDirectoryPath = normalizeAbsolutePath(directoryPath);

  return (
    normalizedFilePath === normalizedDirectoryPath ||
    normalizedFilePath.startsWith(`${normalizedDirectoryPath}/`)
  );
}
