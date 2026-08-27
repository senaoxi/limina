import type { WorkspacePackage } from '#core/workspace/actions';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type { ProjectDependency } from '../core/project-dependencies/contracts';
import type { DependencyGraphCollectionContext } from './collection-types';
import type { DependencyGraphEdgeKind } from './types';

const artifactDirectories = ['dist'] as const;

export interface ResolvedImportPaths {
  graphResolvedFilePath: string;
  resolvedFilePath: string;
  useWorkspaceExportResolution: boolean;
}

function matchesArtifactDirectory(
  targetPackage: WorkspacePackage,
  resolvedPath: string,
): boolean {
  return artifactDirectories.some((artifactDirectory) =>
    isPathInsideDirectory(
      resolvedPath,
      normalizeAbsolutePath(
        path.join(targetPackage.directory, artifactDirectory),
      ),
    ),
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
  if (
    matchesArtifactDirectory(
      options.targetPackage,
      options.paths.resolvedFilePath,
    )
  ) {
    return 'artifact';
  }

  return hasSourceOwner({ context: options.context, paths: options.paths })
    ? 'source'
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
    useWorkspaceExportResolution: false,
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
  declaredTargetPackage: WorkspacePackage | null;
  paths: ResolvedImportPaths;
}): WorkspacePackage | null {
  if (options.paths.useWorkspaceExportResolution) {
    return options.declaredTargetPackage;
  }

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
