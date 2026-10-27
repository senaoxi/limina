import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type ts from 'typescript';

/**
Staged package manifests need the same directory visibility as staged files.
*/
export function withVirtualResolutionFiles<T extends ts.ModuleResolutionHost>(
  host: T,
  files: ReadonlyMap<string, string> | undefined,
): T {
  if (files === undefined || files.size === 0) return host;
  const exists = host.fileExists.bind(host);
  const read = host.readFile.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  const directories = new Set<string>();
  for (const file of files.keys()) addDirectories(directories, file);
  return {
    ...host,
    fileExists: (file) =>
      files.has(normalizeAbsolutePath(file)) || exists(file),
    readFile: (file) => files.get(normalizeAbsolutePath(file)) ?? read(file),
    directoryExists: (directory) =>
      directories.has(normalizeAbsolutePath(directory)) ||
      directoryExists?.(directory) === true,
  };
}

function addDirectories(directories: Set<string>, file: string): void {
  let directory = path.dirname(file);
  while (!directories.has(directory)) {
    directories.add(directory);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}
