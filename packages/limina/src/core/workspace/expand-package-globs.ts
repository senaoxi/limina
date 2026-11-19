import { observeAnalysisRead } from '#utils/analysis-input';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import { glob, globSync } from 'tinyglobby';
import {
  createDirectoryBranchFs,
  createLexicalDirectoryFs,
} from './lexical-directory-fs';
import type {
  WorkspacePackageGlobGroup,
  WorkspacePackageSelectionPolicy,
} from './selection-policy';

type ExpansionOptions = WorkspacePackageSelectionPolicy & { rootDir: string };

function globOptions(options: ExpansionOptions) {
  return {
    absolute: true as const,
    cwd: options.rootDir,
    onlyDirectories: true,
    expandDirectories: false,
    ignore: [...options.hardIgnores],
  };
}

function globGroups(
  options: WorkspacePackageSelectionPolicy,
): readonly WorkspacePackageGlobGroup[] {
  return options.globGroups ?? [{ packageGlobs: options.packageGlobs }];
}

async function expandGroup(
  group: WorkspacePackageGlobGroup,
  options: ExpansionOptions,
): Promise<string[]> {
  const settings = globOptions(options);
  const read = () =>
    glob(group.packageGlobs, {
      ...settings,
      fs: createLexicalDirectoryFs(),
    });
  const directories = await read();
  observeAnalysisRead({
    path: options.rootDir,
    descriptor: {
      kind: 'glob',
      patterns: [...group.packageGlobs],
      lexicalDirectories: true,
      options: settings,
    },
    key: JSON.stringify(['packages', options.rootDir, group.packageGlobs]),
    value: directories,
    read,
  });
  if (group.acceptsDirectory === undefined) return directories;
  const acceptsDirectory = group.acceptsDirectory;
  return directories.filter((directory) =>
    acceptsDirectory(path.relative(options.rootDir, directory)),
  );
}

/**
Enumeration retains lexical aliases; validation owns physical identity.
*/
export async function expandPackageGlobs(
  options: ExpansionOptions,
): Promise<string[]> {
  if (options.packageGlobs.length === 0) return [];
  const directories = (
    await Promise.all(
      globGroups(options).map((group) => expandGroup(group, options)),
    )
  ).flat();
  return [...new Set(directories.map(normalizeAbsolutePath))].sort(
    compareCodeUnits,
  );
}

export function hasPackageDirectory(
  options: ExpansionOptions,
  candidate: string,
): boolean {
  const relative = path.relative(options.rootDir, candidate);
  const settings = {
    ...globOptions(options),
    fs: createDirectoryBranchFs(candidate),
  };
  return globGroups(options).some(
    (group) =>
      group.acceptsDirectory?.(relative) !== false &&
      globSync(group.packageGlobs, settings).some(
        (match) => normalizeAbsolutePath(match) === candidate,
      ),
  );
}
