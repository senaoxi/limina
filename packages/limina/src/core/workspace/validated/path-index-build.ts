import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type { WorkspacePackage } from '../actions';
import type { WorkspaceRegionBoundary } from '../regions';
import type {
  ValidatedWorkspaceContext,
  WorkspacePackageIdentity,
} from './types';

export interface WorkspacePathIndexState {
  boundariesByOwner: Map<string, Map<string, WorkspaceRegionBoundary>>;
  boundaryEntryCount: number;
  identityByCanonicalDirectory: Map<string, WorkspacePackageIdentity>;
  packages: WorkspacePackage[];
  rootDir: string;
  sourceConfigIdentities: Set<string>;
}

function clonePackages(
  packages: readonly WorkspacePackage[],
): WorkspacePackage[] {
  return packages.map((workspacePackage) => ({
    ...workspacePackage,
    manifest: { ...workspacePackage.manifest },
  }));
}

function createIdentityIndex(
  identities: readonly WorkspacePackageIdentity[],
): Map<string, WorkspacePackageIdentity> {
  const index = new Map<string, WorkspacePackageIdentity>();
  for (const identity of identities) {
    if (!index.has(identity.canonicalDirectory)) {
      index.set(identity.canonicalDirectory, identity);
    }
  }
  return index;
}

function groupOwnerCanonicalDirectories(
  identities: ReadonlyMap<string, WorkspacePackageIdentity>,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [canonicalDirectory, identity] of identities) {
    const lexicalDirectory = normalizeAbsolutePath(identity.package.directory);
    const group = groups.get(lexicalDirectory);
    if (group === undefined) groups.set(lexicalDirectory, [canonicalDirectory]);
    else group.push(canonicalDirectory);
  }
  return groups;
}

function collectAncestorDirectories(directory: string): string[] {
  const directories: string[] = [];
  let currentDirectory = normalizeAbsolutePath(directory);
  while (true) {
    directories.push(currentDirectory);
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) return directories;
    currentDirectory = parentDirectory;
  }
}

function findBoundaryOwners(options: {
  boundary: WorkspaceRegionBoundary;
  ownersByLexicalDirectory: ReadonlyMap<string, readonly string[]>;
}): string[] {
  return collectAncestorDirectories(options.boundary.rootDir).flatMap(
    (directory) => options.ownersByLexicalDirectory.get(directory) ?? [],
  );
}

function addBoundaryForOwner(options: {
  boundariesByOwner: Map<string, Map<string, WorkspaceRegionBoundary>>;
  boundary: WorkspaceRegionBoundary;
  canonicalBoundaryRoot: string;
  owner: string;
}): boolean {
  const boundaryIndex = options.boundariesByOwner.get(options.owner);
  if (boundaryIndex === undefined) return false;
  if (boundaryIndex.has(options.canonicalBoundaryRoot)) return false;
  boundaryIndex.set(options.canonicalBoundaryRoot, options.boundary);
  return true;
}

function addBoundaryToIndexes(options: {
  boundariesByOwner: Map<string, Map<string, WorkspaceRegionBoundary>>;
  boundary: WorkspaceRegionBoundary;
  canonicalize: (filePath: string) => string;
  ownersByLexicalDirectory: ReadonlyMap<string, readonly string[]>;
}): number {
  const canonicalBoundaryRoot = options.canonicalize(options.boundary.rootDir);
  const owners = findBoundaryOwners({
    boundary: options.boundary,
    ownersByLexicalDirectory: options.ownersByLexicalDirectory,
  });
  return owners.filter((owner) =>
    addBoundaryForOwner({
      boundariesByOwner: options.boundariesByOwner,
      boundary: options.boundary,
      canonicalBoundaryRoot,
      owner,
    }),
  ).length;
}

function createBoundaryIndexes(options: {
  boundaries: readonly WorkspaceRegionBoundary[];
  canonicalize: (filePath: string) => string;
  identities: ReadonlyMap<string, WorkspacePackageIdentity>;
}): {
  boundariesByOwner: Map<string, Map<string, WorkspaceRegionBoundary>>;
  boundaryEntryCount: number;
} {
  const boundariesByOwner = new Map<
    string,
    Map<string, WorkspaceRegionBoundary>
  >();
  for (const canonicalDirectory of options.identities.keys()) {
    boundariesByOwner.set(canonicalDirectory, new Map());
  }
  const ownersByLexicalDirectory = groupOwnerCanonicalDirectories(
    options.identities,
  );
  const boundaryEntryCount = options.boundaries.reduce(
    (count, boundary) =>
      count +
      addBoundaryToIndexes({
        boundariesByOwner,
        boundary,
        canonicalize: options.canonicalize,
        ownersByLexicalDirectory,
      }),
    0,
  );
  return { boundariesByOwner, boundaryEntryCount };
}

export function createWorkspacePathIndexState(
  context: ValidatedWorkspaceContext,
  canonicalize: (filePath: string) => string,
): WorkspacePathIndexState {
  const identities = [...context.packageIdentities].sort(
    (left, right) =>
      right.canonicalDirectory.length - left.canonicalDirectory.length,
  );
  const identityByCanonicalDirectory = createIdentityIndex(identities);
  const boundaryIndexes = createBoundaryIndexes({
    boundaries: context.boundaries,
    canonicalize,
    identities: identityByCanonicalDirectory,
  });
  return {
    ...boundaryIndexes,
    identityByCanonicalDirectory,
    packages: clonePackages(context.packages),
    rootDir: normalizeAbsolutePath(context.configRootDir),
    sourceConfigIdentities: new Set(
      context.sourceConfigPaths.map(canonicalize),
    ),
  };
}
