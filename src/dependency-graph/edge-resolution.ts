import type { WorkspacePackage } from '#core/workspace/actions';
import { isPathInsideDirectory } from '#utils/path';
import type { ProjectDependency } from '../core/project-dependencies/contracts';
import type { DependencyGraphCollectionContext } from './collection-types';
import type { DependencyGraphEdgeKind } from './types';

export interface ResolvedImportPaths {
  graphResolvedFilePath: string;
  resolvedFilePath: string;
}

function matchesOutputRoot(
  context: DependencyGraphCollectionContext,
  resolvedPath: string,
): boolean {
  const canonicalPath =
    context.pathIndex.classifyPath(resolvedPath).canonicalPath;
  return context.outputRoots.some((root) =>
    isPathInsideDirectory(canonicalPath, root),
  );
}

function hasSourceOwner(options: {
  context: DependencyGraphCollectionContext;
  paths: ResolvedImportPaths;
}): boolean {
  return (
    options.context.fileOwnerLookup.has(options.paths.graphResolvedFilePath) ||
    options.context.fileOwnerLookup.has(options.paths.resolvedFilePath)
  );
}

export function classifyEdge(options: {
  context: DependencyGraphCollectionContext;
  paths: ResolvedImportPaths;
  targetPackage: WorkspacePackage;
}): DependencyGraphEdgeKind | null {
  if (hasSourceOwner(options)) return 'source';
  return matchesOutputRoot(options.context, options.paths.resolvedFilePath)
    ? 'artifact'
    : null;
}

export function viewAllowsEdge(
  context: DependencyGraphCollectionContext,
  edgeKind: DependencyGraphEdgeKind,
): boolean {
  return context.view === 'all' || context.view === edgeKind;
}

export function resolveImportPaths(options: {
  projectDependency: ProjectDependency;
}): ResolvedImportPaths {
  return {
    graphResolvedFilePath: options.projectDependency.resolvedFilePath,
    resolvedFilePath: options.projectDependency.resolvedFilePath,
  };
}

function findGraphResolvedPackage(
  context: DependencyGraphCollectionContext,
  graphResolvedFilePath: string,
): WorkspacePackage | null {
  return context.workspaceLookup.findPackageForFile(graphResolvedFilePath);
}

export function resolveTargetPackage(options: {
  context: DependencyGraphCollectionContext;
  paths: ResolvedImportPaths;
}): WorkspacePackage | null {
  const graphPackage = findGraphResolvedPackage(
    options.context,
    options.paths.graphResolvedFilePath,
  );
  return (
    graphPackage ??
    options.context.workspaceLookup.findPackageForFile(
      options.paths.resolvedFilePath,
    )
  );
}

export function isExternalPackageEdge(
  importerPackage: WorkspacePackage,
  targetPackage: WorkspacePackage | null,
): targetPackage is WorkspacePackage {
  if (targetPackage === null) {
    return false;
  }

  return targetPackage.directory !== importerPackage.directory;
}
