import { realpathSync } from 'node:fs';
import path from 'node:path';

function resolveRealPath(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

export function resolveLeafInstalledPackageDirectory(options: {
  packageName: string;
  packageRootDir: string;
}): string | null {
  return resolveRealPath(
    path.join(
      options.packageRootDir,
      'node_modules',
      ...options.packageName.split('/'),
    ),
  );
}

function isPathInsidePackage(
  packageDirectory: string,
  resolvedPath: string,
): boolean {
  const relativePath = path.relative(packageDirectory, resolvedPath);
  if (relativePath === '') return true;
  return [
    relativePath !== '..',
    !relativePath.startsWith(`..${path.sep}`),
    !path.isAbsolute(relativePath),
  ].every(Boolean);
}

export function isResolvedFromLeafInstalledPackage(options: {
  packageName: string;
  packageRootDir: string;
  resolvedPath: string;
}): boolean {
  const packageDirectory = resolveLeafInstalledPackageDirectory(options);
  const resolvedPath = resolveRealPath(options.resolvedPath);
  if (packageDirectory === null) return false;
  if (resolvedPath === null) return false;
  return isPathInsidePackage(packageDirectory, resolvedPath);
}
