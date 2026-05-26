import path from 'node:path';

export function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

export function normalizeAbsolutePath(value: string): string {
  return toPosixPath(path.resolve(value));
}

export function toRelativePath(rootDir: string, absolutePath: string): string {
  const relativePath = toPosixPath(
    path.relative(rootDir, path.resolve(absolutePath)),
  );

  return relativePath.length === 0 ? '.' : relativePath;
}

export function toAbsolutePath(rootDir: string, workspacePath: string): string {
  return path.resolve(rootDir, workspacePath);
}

export function normalizeWorkspacePath(rootDir: string, value: string): string {
  return toRelativePath(rootDir, value);
}

export function normalizeSlashes(value: string): string {
  return value.replaceAll('\\', '/');
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
