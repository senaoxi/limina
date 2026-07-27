import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import { resolveInternalImport } from '#core/import-graph/context';
import {
  isNamedWorkspacePackage,
  type NamedWorkspacePackage,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type { WorkspacePackageExportResolution } from '../core/workspace/exports';
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

function getNamedTargetPackage(
  targetPackage: WorkspacePackage | null,
): NamedWorkspacePackage | null {
  if (targetPackage === null) {
    return null;
  }

  return isNamedWorkspacePackage(targetPackage) ? targetPackage : null;
}

function getWorkspaceExportResolution(options: {
  context: DependencyGraphCollectionContext;
  declaredTargetPackage: WorkspacePackage | null;
  importRecord: ImportRecord;
  project: ProjectInfo;
}): WorkspacePackageExportResolution | null {
  const targetPackage = getNamedTargetPackage(options.declaredTargetPackage);

  if (targetPackage === null) {
    return null;
  }

  if (!options.context.workspaceExports.hasExports(targetPackage.name)) {
    return null;
  }

  return options.context.workspaceExports.get(
    options.project.configPath,
    options.importRecord.specifier,
  );
}

function shouldUseWorkspaceExportResolution(options: {
  declaredTargetPackage: WorkspacePackage | null;
  internalResolvedFilePath: string | null;
}): boolean {
  return (
    options.declaredTargetPackage !== null &&
    options.internalResolvedFilePath === null
  );
}

function getOxcResolvedPath(
  resolution: WorkspacePackageExportResolution | null,
): string | null {
  return resolution === null ? null : resolution.oxcResolvedFileName;
}

function selectResolvedFilePath(options: {
  internalResolvedFilePath: string | null;
  useWorkspaceExportResolution: boolean;
  workspaceExportResolution: WorkspacePackageExportResolution | null;
}): string | null {
  if (!options.useWorkspaceExportResolution) {
    return options.internalResolvedFilePath;
  }

  return (
    getOxcResolvedPath(options.workspaceExportResolution) ??
    options.internalResolvedFilePath
  );
}

function getTypeScriptResolvedPath(
  resolution: WorkspacePackageExportResolution | null,
): string | null {
  return resolution === null ? null : resolution.typeScriptResolvedFileName;
}

function selectGraphResolvedFilePath(options: {
  resolvedFilePath: string;
  useWorkspaceExportResolution: boolean;
  workspaceExportResolution: WorkspacePackageExportResolution | null;
}): string {
  if (!options.useWorkspaceExportResolution) {
    return options.resolvedFilePath;
  }

  return (
    getTypeScriptResolvedPath(options.workspaceExportResolution) ??
    options.resolvedFilePath
  );
}

export function resolveImportPaths(options: {
  context: DependencyGraphCollectionContext;
  declaredTargetPackage: WorkspacePackage | null;
  fileName: string;
  importRecord: ImportRecord;
  project: ProjectInfo;
}): ResolvedImportPaths | null {
  const workspaceExportResolution = getWorkspaceExportResolution(options);
  const internalResolvedFilePath = resolveInternalImport(
    options.importRecord.specifier,
    options.fileName,
    options.project.options,
    options.project,
    options.context.importAnalysis,
  );
  const useWorkspaceExportResolution = shouldUseWorkspaceExportResolution({
    declaredTargetPackage: options.declaredTargetPackage,
    internalResolvedFilePath,
  });
  const resolvedFilePath = selectResolvedFilePath({
    internalResolvedFilePath,
    useWorkspaceExportResolution,
    workspaceExportResolution,
  });

  if (resolvedFilePath === null) {
    return null;
  }

  return {
    graphResolvedFilePath: selectGraphResolvedFilePath({
      resolvedFilePath,
      useWorkspaceExportResolution,
      workspaceExportResolution,
    }),
    resolvedFilePath,
    useWorkspaceExportResolution,
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
