import {
  getPublishDependencySections,
  type PackageManifest,
} from '#core/workspace/actions';
import type {
  PackageDependencyEntry,
  PackageDependencySectionName,
  PublishDependencyEntry,
  PublishManifest,
  ReleaseConsistencyState,
} from './types';

export function isLinkDependencySpecifier(specifier: string): boolean {
  return specifier.startsWith('link:');
}

export function createReleaseConsistencyState(): ReleaseConsistencyState {
  return {
    changedPackageNames: new Set<string>(),
    directWorkspaceDependencies: [],
    edges: new Map<string, Set<string>>(),
    findings: [],
    registryMetadataCache: new Map(),
    unpublishedPackageNames: new Set<string>(),
    visitedPackages: new Set<string>(),
  };
}

export function collectPublishDependencyEntries(
  manifest: PublishManifest | PackageManifest,
): PublishDependencyEntry[] {
  const entries: PublishDependencyEntry[] = [];
  for (const { dependencies, name } of getPublishDependencySections(manifest)) {
    for (const [dependencyName, specifier] of Object.entries(dependencies)) {
      entries.push({ dependencyName, sectionName: name, specifier });
    }
  }
  return entries;
}

function getPackageDependencySections(
  manifest: PublishManifest | PackageManifest,
): {
  dependencies: Record<string, string> | undefined;
  name: PackageDependencySectionName;
}[] {
  return [
    { dependencies: manifest.dependencies, name: 'dependencies' },
    { dependencies: manifest.devDependencies, name: 'devDependencies' },
    { dependencies: manifest.peerDependencies, name: 'peerDependencies' },
    {
      dependencies: manifest.optionalDependencies,
      name: 'optionalDependencies',
    },
  ];
}

function collectSectionEntries(options: {
  dependencies: Record<string, string> | undefined;
  name: PackageDependencySectionName;
}): PackageDependencyEntry[] {
  if (options.dependencies === undefined) return [];
  return Object.entries(options.dependencies).map(
    ([dependencyName, specifier]) => ({
      dependencyName,
      sectionName: options.name,
      specifier,
    }),
  );
}

export function collectPackageDependencyEntries(
  manifest: PublishManifest | PackageManifest,
): PackageDependencyEntry[] {
  return getPackageDependencySections(manifest).flatMap(collectSectionEntries);
}

export function addEdge(
  edges: Map<string, Set<string>>,
  importerName: string,
  dependencyName: string,
): void {
  const dependencies = edges.get(importerName) ?? new Set<string>();
  dependencies.add(dependencyName);
  edges.set(importerName, dependencies);
}

export function getPackedDependencySpecifier(
  manifest: PublishManifest,
  dependencyName: string,
): string | undefined {
  for (const { dependencies } of getPublishDependencySections(manifest)) {
    const specifier = dependencies[dependencyName];
    if (specifier !== undefined) return specifier;
  }
  return undefined;
}
