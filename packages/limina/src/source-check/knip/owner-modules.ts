import type { PackageOwner } from '#core/workspace/actions';
import { normalizeAbsolutePath } from '#utils/path';
import type { WorkspaceLookupIndex } from '../../core/workspace/lookup';
import type { OwnerSourceModuleSet } from './unused/types';

function hasProvidedPackageExports(owner: PackageOwner): boolean {
  return Object.hasOwn(owner.manifest, 'exports');
}

function findNamedOwner(options: {
  filePath: string;
  workspaceLookup: WorkspaceLookupIndex;
}): PackageOwner | null {
  const owner = options.workspaceLookup.findOwnerForFile(options.filePath);
  if (owner === null) return null;
  return owner.name === undefined ? null : owner;
}

function addOwnerFile(options: {
  filePath: string;
  filesByOwner: Map<string, { files: Set<string>; owner: PackageOwner }>;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const filePath = normalizeAbsolutePath(options.filePath);
  const owner = findNamedOwner({
    filePath,
    workspaceLookup: options.workspaceLookup,
  });
  if (owner === null) return;
  const ownerFiles = options.filesByOwner.get(owner.packageJsonPath) ?? {
    files: new Set<string>(),
    owner,
  };
  ownerFiles.files.add(filePath);
  options.filesByOwner.set(owner.packageJsonPath, ownerFiles);
}

function toModuleSet(options: {
  files: Set<string>;
  owner: PackageOwner;
}): OwnerSourceModuleSet {
  return {
    checkUnusedFiles: hasProvidedPackageExports(options.owner),
    files: [...options.files].sort((left, right) => left.localeCompare(right)),
    owner: options.owner,
  };
}

export function collectOwnerSourceModuleSets(options: {
  sourceProjectEntries: { fileNames: string[] }[];
  workspaceLookup: WorkspaceLookupIndex;
}): OwnerSourceModuleSet[] {
  const filesByOwner = new Map<
    string,
    { files: Set<string>; owner: PackageOwner }
  >();
  for (const sourceProjectEntry of options.sourceProjectEntries) {
    for (const fileName of sourceProjectEntry.fileNames) {
      addOwnerFile({
        filePath: fileName,
        filesByOwner,
        workspaceLookup: options.workspaceLookup,
      });
    }
  }
  return [...filesByOwner.values()]
    .map(toModuleSet)
    .sort((left, right) =>
      left.owner.packageJsonPath.localeCompare(right.owner.packageJsonPath),
    );
}
