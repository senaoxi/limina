import type { PackageOwner } from '#core/workspace/actions';
import type { WorkspaceLookupIndex } from '../../core/workspace/lookup';
import {
  getPackageOwnerIdentity,
  type PackageOwnerIdentity,
  projectToPackageOwnerPath,
} from '../../core/workspace/owner-identity';
import type {
  ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../../core/workspace/validated-context';
import type { OwnerSourceModuleSet } from './unused/types';

function hasProvidedPackageExports(owner: PackageOwner): boolean {
  return Object.hasOwn(owner.manifest, 'exports');
}

function findOwner(options: {
  filePath: string;
  workspaceLookup: WorkspaceLookupIndex;
  workspaceContext: ValidatedWorkspaceContext;
  pathIndex: WorkspaceRegionPathIndex;
}): PackageOwner | null {
  const owner = options.workspaceLookup.findOwnerForFile(options.filePath);
  if (owner === null) return null;
  return owner;
}

function addOwnerFile(options: {
  filePath: string;
  filesByOwner: Map<
    string,
    {
      files: Set<string>;
      owner: PackageOwner;
      ownerIdentity: PackageOwnerIdentity;
    }
  >;
  workspaceLookup: WorkspaceLookupIndex;
  workspaceContext: ValidatedWorkspaceContext;
  pathIndex: WorkspaceRegionPathIndex;
}): void {
  const filePath = projectToPackageOwnerPath(
    options.pathIndex,
    options.filePath,
  );
  if (filePath === null) return;
  const owner = findOwner({
    filePath,
    workspaceLookup: options.workspaceLookup,
    workspaceContext: options.workspaceContext,
    pathIndex: options.pathIndex,
  });
  if (owner === null) return;
  const ownerIdentity = getPackageOwnerIdentity(
    options.workspaceContext,
    owner.directory,
  );
  const ownerFiles = getOwnerFiles(options.filesByOwner, owner, ownerIdentity);
  ownerFiles.files.add(filePath);
  options.filesByOwner.set(ownerIdentity, ownerFiles);
}

function getOwnerFiles(
  filesByOwner: Parameters<typeof addOwnerFile>[0]['filesByOwner'],
  owner: PackageOwner,
  ownerIdentity: PackageOwnerIdentity,
) {
  return (
    filesByOwner.get(ownerIdentity) ?? {
      files: new Set<string>(),
      owner,
      ownerIdentity,
    }
  );
}

function toModuleSet(options: {
  files: Set<string>;
  owner: PackageOwner;
  ownerIdentity: PackageOwnerIdentity;
}): OwnerSourceModuleSet {
  return {
    checkUnusedFiles: hasProvidedPackageExports(options.owner),
    files: [...options.files].sort((left, right) => left.localeCompare(right)),
    owner: options.owner,
    ownerIdentity: options.ownerIdentity,
  };
}

export function collectOwnerSourceModuleSets(options: {
  sourceProjectEntries: { fileNames: string[] }[];
  workspaceLookup: WorkspaceLookupIndex;
  workspaceContext: ValidatedWorkspaceContext;
  pathIndex: WorkspaceRegionPathIndex;
}): OwnerSourceModuleSet[] {
  const filesByOwner = new Map<
    string,
    {
      files: Set<string>;
      owner: PackageOwner;
      ownerIdentity: PackageOwnerIdentity;
    }
  >();
  for (const sourceProjectEntry of options.sourceProjectEntries) {
    for (const fileName of sourceProjectEntry.fileNames) {
      addOwnerFile({
        filePath: fileName,
        filesByOwner,
        workspaceLookup: options.workspaceLookup,
        workspaceContext: options.workspaceContext,
        pathIndex: options.pathIndex,
      });
    }
  }
  return [...filesByOwner.values()]
    .map(toModuleSet)
    .sort((left, right) =>
      left.owner.packageJsonPath.localeCompare(right.owner.packageJsonPath),
    );
}
