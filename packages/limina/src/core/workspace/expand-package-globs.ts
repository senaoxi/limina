import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import { glob } from 'tinyglobby';
import { createLexicalDirectoryFs } from './lexical-directory-fs';
import type {
  WorkspacePackageGlobGroup,
  WorkspacePackageSelectionPolicy,
} from './selection-policy';

type ExpansionOptions = WorkspacePackageSelectionPolicy & { rootDir: string };

async function expandGroup(
  group: WorkspacePackageGlobGroup,
  options: ExpansionOptions,
): Promise<string[]> {
  const directories = await glob([...group.packageGlobs], {
    fs: createLexicalDirectoryFs(),
    absolute: true,
    cwd: options.rootDir,
    onlyDirectories: true,
    expandDirectories: false,
    ignore: [...options.hardIgnores],
  });
  if (group.acceptsDirectory === undefined) return directories;
  const acceptsDirectory = group.acceptsDirectory;
  return directories.filter((directory) =>
    acceptsDirectory(path.relative(options.rootDir, directory)),
  );
}

/** Enumeration retains lexical aliases; validation owns physical identity. */
export async function expandPackageGlobs(
  options: ExpansionOptions,
): Promise<string[]> {
  if (options.packageGlobs.length === 0) return [];
  const groups = options.globGroups ?? [{ packageGlobs: options.packageGlobs }];
  const directories = (
    await Promise.all(groups.map((group) => expandGroup(group, options)))
  ).flat();
  return [...new Set(directories.map(normalizeAbsolutePath))].sort();
}
