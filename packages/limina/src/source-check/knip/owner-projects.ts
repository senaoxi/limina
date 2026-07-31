import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import type { KnipOwnerProject } from '../knip';
import {
  collectManifestSourceEntryPatterns,
  createOwnerSourceFileKey,
  type OwnerSourceModuleSet,
} from './unused';

function getOwnerEntryPatterns(options: {
  entryPatternsByOwnerName: Map<string, string[]>;
  moduleSet: OwnerSourceModuleSet;
}): string[] {
  const ownerName = options.moduleSet.owner.name as string;

  return uniqueSortedStrings([
    ...(options.entryPatternsByOwnerName.get(ownerName) ?? []),
    ...collectManifestSourceEntryPatterns(options.moduleSet),
  ]);
}

function getIgnoredProjectFiles(options: {
  ignoredModuleKeys: Set<string>;
  moduleSet: OwnerSourceModuleSet;
}): string[] {
  const ownerName = options.moduleSet.owner.name as string;

  return options.moduleSet.files
    .filter((filePath) =>
      options.ignoredModuleKeys.has(
        createOwnerSourceFileKey(ownerName, filePath),
      ),
    )
    .map((filePath) =>
      toRelativePath(options.moduleSet.owner.directory, filePath),
    )
    .sort();
}

function getProjectFiles(options: {
  includeFiles: boolean;
  moduleSet: OwnerSourceModuleSet;
}): string[] {
  if (!options.includeFiles) {
    return [];
  }

  return options.moduleSet.files
    .map((filePath) =>
      toRelativePath(options.moduleSet.owner.directory, filePath),
    )
    .sort();
}

function getVirtualEntryFiles(moduleSet: OwnerSourceModuleSet): string[] {
  return moduleSet.checkUnusedFiles ? [] : moduleSet.files;
}

export function createKnipOwnerProjects(options: {
  entryPatternsByOwnerName: Map<string, string[]>;
  ignoredModuleKeys: Set<string>;
  includeFiles: boolean;
  ownerModuleSets: OwnerSourceModuleSet[];
}): KnipOwnerProject[] {
  return options.ownerModuleSets.map((moduleSet) => ({
    directory: moduleSet.owner.directory,
    entryFiles: getOwnerEntryPatterns({ ...options, moduleSet }),
    ignoreFiles: getIgnoredProjectFiles({ ...options, moduleSet }),
    projectFiles: getProjectFiles({ ...options, moduleSet }),
    virtualEntrySourceFiles: getVirtualEntryFiles(moduleSet),
  }));
}
