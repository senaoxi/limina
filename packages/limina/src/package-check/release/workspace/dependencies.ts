import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isWorkspaceDependencySpecifier,
  type NamedWorkspacePackage,
  type PackageManifest,
} from '#core/workspace/actions';
import path from 'pathe';
import {
  addEdge,
  collectPublishDependencyEntries,
  isLinkDependencySpecifier,
} from '../consistency/dependencies';
import {
  addPackedManifestFinding,
  formatDependencyLocation,
} from '../consistency/findings';
import type {
  PublishDependencyEntry,
  ReleaseConsistencyState,
} from '../consistency/types';
import { verifyWorkspacePackagePublished } from './published';

interface DependencyTraversalContext {
  config: ResolvedLiminaConfig;
  importerName: string;
  isRoot: boolean;
  manifestPath: string;
  state: ReleaseConsistencyState;
  workspacePackagesByName: Map<string, NamedWorkspacePackage>;
}

function addLinkDependencyFinding(options: {
  context: DependencyTraversalContext;
  entry: PublishDependencyEntry;
}): void {
  addPackedManifestFinding(options.context.state, {
    facts: {
      dependencyName: options.entry.dependencyName,
      importerName: options.context.importerName,
      kind: 'source-link-dependency',
      sectionName: options.entry.sectionName,
      sourceManifestPath: options.context.manifestPath,
      specifier: options.entry.specifier,
    },
    filePath: options.context.manifestPath,
    message: `${formatDependencyLocation({
      dependencyName: options.entry.dependencyName,
      importerName: options.context.importerName,
      sectionName: options.entry.sectionName,
      specifier: options.entry.specifier,
    })}: publishable dependency sections must not use link:`,
    packageManifestPath: options.context.manifestPath,
    packageName: options.context.importerName,
    section: 'source-link',
    sectionTitle: 'Source manifest contains local link: publish dependencies:',
  });
}

function addMissingWorkspaceDependencyFinding(options: {
  context: DependencyTraversalContext;
  entry: PublishDependencyEntry;
}): void {
  addPackedManifestFinding(options.context.state, {
    facts: {
      dependencyName: options.entry.dependencyName,
      importerName: options.context.importerName,
      kind: 'source-workspace-dependency-missing',
      sectionName: options.entry.sectionName,
      sourceManifestPath: options.context.manifestPath,
      specifier: options.entry.specifier,
    },
    filePath: options.context.manifestPath,
    message: `${formatDependencyLocation({
      dependencyName: options.entry.dependencyName,
      importerName: options.context.importerName,
      sectionName: options.entry.sectionName,
      specifier: options.entry.specifier,
    })}: workspace: publish dependency does not match a named workspace package`,
    packageManifestPath: options.context.manifestPath,
    packageName: options.context.importerName,
    section: 'source-workspace',
    sectionTitle:
      'Source manifest has invalid workspace: publish dependencies:',
  });
}

function addPrivateDependencyFinding(options: {
  context: DependencyTraversalContext;
  entry: PublishDependencyEntry;
  targetPackage: NamedWorkspacePackage;
}): void {
  addPackedManifestFinding(options.context.state, {
    facts: {
      dependencyName: options.entry.dependencyName,
      importerName: options.context.importerName,
      kind: 'source-private-dependency',
      sectionName: options.entry.sectionName,
      sourceManifestPath: options.context.manifestPath,
      specifier: options.entry.specifier,
      targetManifestPath: path.join(
        options.targetPackage.directory,
        'package.json',
      ),
    },
    filePath: options.context.manifestPath,
    message: `${formatDependencyLocation({
      dependencyName: options.entry.dependencyName,
      importerName: options.context.importerName,
      sectionName: options.entry.sectionName,
      specifier: options.entry.specifier,
    })}: publishable packages cannot depend on a private workspace package`,
    packageManifestPath: options.context.manifestPath,
    packageName: options.context.importerName,
    section: 'source-private',
    sectionTitle: 'Source manifest depends on private workspace packages:',
  });
}

function resolveWorkspaceTarget(options: {
  context: DependencyTraversalContext;
  entry: PublishDependencyEntry;
}): NamedWorkspacePackage | null {
  const targetPackage = options.context.workspacePackagesByName.get(
    options.entry.dependencyName,
  );
  if (targetPackage === undefined) {
    addMissingWorkspaceDependencyFinding(options);
    return null;
  }
  return targetPackage;
}

function rejectPrivateWorkspaceTarget(options: {
  context: DependencyTraversalContext;
  entry: PublishDependencyEntry;
  targetPackage: NamedWorkspacePackage;
}): boolean {
  if (options.targetPackage.manifest.private !== true) return false;
  addPrivateDependencyFinding(options);
  return true;
}

function recordWorkspaceDependency(options: {
  context: DependencyTraversalContext;
  entry: PublishDependencyEntry;
  targetPackage: NamedWorkspacePackage;
}): void {
  addEdge(
    options.context.state.edges,
    options.context.importerName,
    options.targetPackage.name,
  );
  if (!options.context.isRoot) return;
  options.context.state.directWorkspaceDependencies.push({
    dependencyName: options.entry.dependencyName,
    sectionName: options.entry.sectionName,
    targetPackage: options.targetPackage,
  });
}

async function visitTargetPackage(options: {
  context: DependencyTraversalContext;
  targetPackage: NamedWorkspacePackage;
}): Promise<void> {
  if (options.context.state.visitedPackages.has(options.targetPackage.name)) {
    return;
  }
  options.context.state.visitedPackages.add(options.targetPackage.name);
  await verifyWorkspacePackagePublished({
    config: options.context.config,
    importerName: options.context.importerName,
    state: options.context.state,
    workspacePackage: options.targetPackage,
  });
  await visitWorkspacePackageDependencies({
    config: options.context.config,
    importerName: options.targetPackage.name,
    isRoot: false,
    manifest: options.targetPackage.manifest,
    manifestPath: path.join(options.targetPackage.directory, 'package.json'),
    state: options.context.state,
    workspacePackagesByName: options.context.workspacePackagesByName,
  });
}

async function processWorkspaceEntry(options: {
  context: DependencyTraversalContext;
  entry: PublishDependencyEntry;
}): Promise<void> {
  const targetPackage = resolveWorkspaceTarget(options);
  if (targetPackage === null) return;
  const targetOptions = { ...options, targetPackage };
  recordWorkspaceDependency(targetOptions);
  if (rejectPrivateWorkspaceTarget(targetOptions)) return;
  await visitTargetPackage({ context: options.context, targetPackage });
}

async function processDependencyEntry(options: {
  context: DependencyTraversalContext;
  entry: PublishDependencyEntry;
}): Promise<void> {
  if (isLinkDependencySpecifier(options.entry.specifier)) {
    addLinkDependencyFinding(options);
    return;
  }
  if (!isWorkspaceDependencySpecifier(options.entry.specifier)) return;
  await processWorkspaceEntry(options);
}

export async function visitWorkspacePackageDependencies(options: {
  config: ResolvedLiminaConfig;
  importerName: string;
  isRoot: boolean;
  manifest: PackageManifest;
  manifestPath: string;
  state: ReleaseConsistencyState;
  workspacePackagesByName: Map<string, NamedWorkspacePackage>;
}): Promise<void> {
  const context: DependencyTraversalContext = options;
  for (const entry of collectPublishDependencyEntries(options.manifest)) {
    await processDependencyEntry({ context, entry });
  }
}
