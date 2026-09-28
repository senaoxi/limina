import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type { WorkspacePackage } from '../actions';
import type { WorkspaceRegionBoundary } from '../regions';
import {
  createGovernanceTrieNode,
  getGovernanceEvent,
  type GovernanceTrieEvents,
  type GovernanceTrieNode,
  insertGovernancePath,
  precomputeGovernanceState,
} from './governance-trie';
import type {
  ValidatedWorkspaceContext,
  WorkspacePackageIdentity,
} from './types';

export interface WorkspacePathIndexState {
  boundaryEntryCount: number;
  packageEntryCount: number;
  root: GovernanceTrieNode;
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

function addBoundaryCuts(
  cuts: Map<string, WorkspaceRegionBoundary>,
  owners: readonly string[],
  boundary: WorkspaceRegionBoundary,
): number {
  let count = 0;
  for (const owner of owners) {
    if (cuts.has(owner)) continue;
    cuts.set(owner, boundary);
    count += 1;
  }
  return count;
}

function insertBoundary(options: {
  boundary: WorkspaceRegionBoundary;
  canonicalRoot: string;
  events: GovernanceTrieEvents;
  ownersByLexicalDirectory: ReadonlyMap<string, readonly string[]>;
  root: GovernanceTrieNode;
}): number {
  const owners = findBoundaryOwners(options);
  if (owners.length === 0) return 0;
  const node = insertGovernancePath(options.root, options.canonicalRoot);
  const event = getGovernanceEvent(options.events, node);
  event.cuts ??= new Map();
  return addBoundaryCuts(event.cuts, owners, options.boundary);
}

function insertBoundaries(options: {
  boundaries: readonly WorkspaceRegionBoundary[];
  canonicalize: (filePath: string) => string;
  events: GovernanceTrieEvents;
  identities: ReadonlyMap<string, WorkspacePackageIdentity>;
  root: GovernanceTrieNode;
}): number {
  const ownersByLexicalDirectory = groupOwnerCanonicalDirectories(
    options.identities,
  );
  let count = 0;
  for (const boundary of options.boundaries) {
    count += insertBoundary({
      boundary,
      canonicalRoot: options.canonicalize(boundary.rootDir),
      events: options.events,
      ownersByLexicalDirectory,
      root: options.root,
    });
  }
  return count;
}

export function createWorkspacePathIndexState(
  context: ValidatedWorkspaceContext,
  canonicalize: (filePath: string) => string,
): WorkspacePathIndexState {
  const root = createGovernanceTrieNode('');
  const events: GovernanceTrieEvents = new Map();
  const identities = createIdentityIndex(context.packageIdentities);
  for (const identity of identities.values()) {
    const node = insertGovernancePath(root, identity.canonicalDirectory);
    getGovernanceEvent(events, node).activation = identity;
  }
  const boundaryEntryCount = insertBoundaries({
    boundaries: context.boundaries,
    canonicalize,
    events,
    identities,
    root,
  });
  precomputeGovernanceState(root, events);
  return {
    boundaryEntryCount,
    packageEntryCount: identities.size,
    packages: clonePackages(context.packages),
    root,
    rootDir: normalizeAbsolutePath(context.configRootDir),
    sourceConfigIdentities: new Set(
      context.sourceConfigPaths.map(canonicalize),
    ),
  };
}
