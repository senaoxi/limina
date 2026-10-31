import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type ts from 'typescript';

/**
Staged files and compiler-planned outputs expose their directory ancestry.
Planned outputs supply no file content, membership, or write authority.
*/
export function withVirtualResolutionFiles<T extends ts.ModuleResolutionHost>(
  host: T,
  files: ReadonlyMap<string, string> | undefined,
  plannedOutputs: readonly string[] = [],
): T {
  if (!files?.size && plannedOutputs.length === 0) return host;
  const exists = host.fileExists.bind(host);
  const read = host.readFile.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  const directories = new Set<string>();
  const staged = files?.keys() ?? [];
  for (const file of staged) addDirectories(directories, file);
  for (const file of plannedOutputs)
    addDirectories(directories, normalizeAbsolutePath(file));
  return {
    ...host,
    fileExists: (file) =>
      files?.has(normalizeAbsolutePath(file)) === true || exists(file),
    readFile: (file) => files?.get(normalizeAbsolutePath(file)) ?? read(file),
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
