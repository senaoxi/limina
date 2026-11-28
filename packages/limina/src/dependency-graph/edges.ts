import type { ImportRecord } from '#core/import-graph/context';
import {
  isNamedWorkspacePackage,
  type NamedWorkspacePackage,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { isPathInsideDirectory, toRelativePath } from '#utils/path';
import path from 'pathe';
import type {
  ProjectDependency,
  ProjectDependencyCollection,
} from '../core/project-dependencies/contracts';
import {
  describeWorkspaceConsumptionFailure,
  getWorkspaceConsumptionFailure,
  type WorkspaceConsumption,
} from '../core/project-dependencies/workspace-consumption';
import {
  addEdge,
  createPackageNodeId,
  type DependencyGraphEdgeKind,
} from './model';
import type { DependencyGraphCollectionContext } from './runner';

interface ResolvedImportPaths {
  graphResolvedFilePath: string;
  resolvedFilePath: string;
}

function isMatchesOutputRoot(
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

function classifyEdge(options: {
  context: DependencyGraphCollectionContext;
  paths: ResolvedImportPaths;
  targetPackage: WorkspacePackage;
}): DependencyGraphEdgeKind | null {
  if (hasSourceOwner(options)) return 'source';
  return isMatchesOutputRoot(options.context, options.paths.resolvedFilePath)
    ? 'artifact'
    : null;
}

function isViewAllowsEdge(
  context: DependencyGraphCollectionContext,
  edgeKind: DependencyGraphEdgeKind,
): boolean {
  return context.view === 'all' || context.view === edgeKind;
}

function resolveImportPaths(options: {
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

function resolveTargetPackage(options: {
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

function isExternalPackageEdge(
  importerPackage: WorkspacePackage,
  targetPackage: WorkspacePackage | null,
): targetPackage is WorkspacePackage {
  return (
    targetPackage !== null &&
    targetPackage.directory !== importerPackage.directory
  );
}

function addNamelessGraphPackageProblem(options: {
  context: DependencyGraphCollectionContext;
  importRecord: ImportRecord;
  packageRole: 'importer' | 'target';
  resolvedFilePath: string;
  workspacePackage: WorkspacePackage;
}): void {
  options.context.problems.push(
    [
      'Dependency graph package identity requires package.json name:',
      `  package.json: ${toRelativePath(options.context.config.rootDir, path.join(options.workspacePackage.directory, 'package.json'))}`,
      `  role: ${options.packageRole}`,
      `  file: ${toRelativePath(options.context.config.rootDir, options.importRecord.filePath)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  resolved file: ${toRelativePath(options.context.config.rootDir, options.resolvedFilePath)}`,
      '  reason: dependency graph nodes and edges are keyed by package name; nameless workspace packages can be source owners but cannot appear as dependency graph nodes.',
      '  fix: add a non-empty package.json name when this workspace package should appear in the dependency graph.',
    ].join('\n'),
  );
}

function isValidateNamedPackage(options: {
  context: DependencyGraphCollectionContext;
  importRecord: ImportRecord;
  packageRole: 'importer' | 'target';
  resolvedFilePath: string;
  workspacePackage: WorkspacePackage;
}): options is typeof options & {
  workspacePackage: NamedWorkspacePackage;
} {
  if (isNamedWorkspacePackage(options.workspacePackage)) {
    return true;
  }

  addNamelessGraphPackageProblem(options);
  return false;
}

interface NamedEdgePackages {
  importerPackage: NamedWorkspacePackage;
  targetPackage: NamedWorkspacePackage;
}

function validateNamedPackages(options: {
  context: DependencyGraphCollectionContext;
  importerPackage: WorkspacePackage;
  importRecord: ImportRecord;
  resolvedFilePath: string;
  targetPackage: WorkspacePackage;
}): NamedEdgePackages | null {
  const importerOptions = {
    context: options.context,
    importRecord: options.importRecord,
    packageRole: 'importer' as const,
    resolvedFilePath: options.resolvedFilePath,
    workspacePackage: options.importerPackage,
  };

  if (!isValidateNamedPackage(importerOptions)) {
    return null;
  }

  const targetOptions = {
    context: options.context,
    importRecord: options.importRecord,
    packageRole: 'target' as const,
    resolvedFilePath: options.resolvedFilePath,
    workspacePackage: options.targetPackage,
  };

  if (!isValidateNamedPackage(targetOptions)) {
    return null;
  }

  return {
    importerPackage: importerOptions.workspacePackage,
    targetPackage: targetOptions.workspacePackage,
  };
}

interface EdgeCandidate {
  edgeKind: DependencyGraphEdgeKind;
  importerPackage: WorkspacePackage;
  paths: ResolvedImportPaths;
  targetPackage: WorkspacePackage;
}

interface ImportProcessingOptions {
  context: DependencyGraphCollectionContext;
  importerPackage: WorkspacePackage;
  importRecord: ImportRecord;
  projectDependency: ProjectDependency;
}

function resolveExternalCandidate(
  options: ImportProcessingOptions,
): Omit<EdgeCandidate, 'edgeKind'> | null {
  const paths = resolveImportPaths({
    projectDependency: options.projectDependency,
  });

  if (paths === null) {
    return null;
  }

  const targetPackage = resolveTargetPackage({
    context: options.context,
    paths,
  });

  if (!isExternalPackageEdge(options.importerPackage, targetPackage)) {
    return null;
  }

  return {
    importerPackage: options.importerPackage,
    paths,
    targetPackage,
  };
}

function createAllowedCandidate(options: {
  candidate: Omit<EdgeCandidate, 'edgeKind'>;
  context: DependencyGraphCollectionContext;
  edgeKind: DependencyGraphEdgeKind;
}): EdgeCandidate | null {
  return isViewAllowsEdge(options.context, options.edgeKind)
    ? { ...options.candidate, edgeKind: options.edgeKind }
    : null;
}

function resolveClassifiedCandidate(
  options: ImportProcessingOptions,
): EdgeCandidate | null {
  const candidate = resolveExternalCandidate(options);

  if (candidate === null) {
    return null;
  }

  const edgeKind = classifyEdge({
    context: options.context,
    paths: candidate.paths,
    targetPackage: candidate.targetPackage,
  });

  if (edgeKind === null) {
    return null;
  }

  return createAllowedCandidate({
    candidate,
    context: options.context,
    edgeKind,
  });
}

function addResolvedImportEdge(options: {
  candidate: EdgeCandidate;
  context: DependencyGraphCollectionContext;
  importRecord: ImportRecord;
}): void {
  const namedPackages = validateNamedPackages({
    context: options.context,
    importerPackage: options.candidate.importerPackage,
    importRecord: options.importRecord,
    resolvedFilePath: options.candidate.paths.resolvedFilePath,
    targetPackage: options.candidate.targetPackage,
  });

  if (namedPackages === null) {
    return;
  }

  addEdge(options.context.edgesByKey, {
    evidence: {
      importer: toRelativePath(
        options.context.config.rootDir,
        options.importRecord.filePath,
      ),
      resolvedPath: toRelativePath(
        options.context.config.rootDir,
        options.candidate.paths.resolvedFilePath,
      ),
      specifier: options.importRecord.specifier,
    },
    from: createPackageNodeId(namedPackages.importerPackage.name),
    kind: options.candidate.edgeKind,
    to: createPackageNodeId(namedPackages.targetPackage.name),
  });
}

function processImportRecord(options: ImportProcessingOptions): void {
  if (isAddConsumptionFailure(options.context, options.projectDependency))
    return;
  const candidate = resolveClassifiedCandidate(options);

  if (candidate !== null) {
    addResolvedImportEdge({
      candidate,
      context: options.context,
      importRecord: options.importRecord,
    });
  }
}

function collectDependencyGraphFailures(
  context: DependencyGraphCollectionContext,
  failures: ProjectDependencyCollection['failures'],
): void {
  for (const failure of failures) {
    context.problems.push(
      [
        'Dependency graph semantic collection failed:',
        `  config: ${toRelativePath(context.config.rootDir, failure.configPath)}`,
        `  framework: ${failure.framework}`,
        `  stage: ${failure.stage}`,
        `  reason: ${failure.reason}`,
      ].join('\n'),
    );
  }
}

function collectDependencyGraphDependencies(
  context: DependencyGraphCollectionContext,
  dependencies: ProjectDependencyCollection['dependencies'],
): void {
  for (const projectDependency of dependencies) {
    const importRecord = projectDependency.importRecord;
    const importerPackage = context.workspaceLookup.findPackageForFile(
      importRecord.filePath,
    );
    if (importerPackage === null) continue;
    processImportRecord({
      context,
      importerPackage,
      importRecord,
      projectDependency,
    });
  }
}

export function collectDependencyGraphEdges(
  context: DependencyGraphCollectionContext,
): void {
  for (const collection of context.projectDependencies) {
    if (typeof collection === 'string') {
      context.problems.push(collection);
      continue;
    }
    collectDependencyGraphFailures(context, collection.failures);
    collectDependencyGraphObservations(context, collection.observations);
    collectDependencyGraphDependencies(context, collection.dependencies);
  }
}

function isAddConsumptionFailure(
  context: DependencyGraphCollectionContext,
  consumption: WorkspaceConsumption,
): boolean {
  const failure = getWorkspaceConsumptionFailure({
    consumption,
    workspaceLookup: context.workspaceLookup,
  });
  if (failure === null) return false;
  context.problems.push(
    [
      'Unresolved workspace import:',
      ...describeWorkspaceConsumptionFailure(failure),
    ].join('\n'),
  );
  return true;
}

function collectDependencyGraphObservations(
  context: DependencyGraphCollectionContext,
  observations: ProjectDependencyCollection['observations'],
): void {
  for (const observation of observations) {
    if (observation.kind !== 'unmapped-generated')
      isAddConsumptionFailure(context, observation);
  }
}
