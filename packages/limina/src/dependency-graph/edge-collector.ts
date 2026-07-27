import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import { collectImportsFromFile } from '#core/import-graph/context';
import {
  findPackageForSpecifier,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import type { DependencyGraphCollectionContext } from './collection-types';
import {
  classifyEdge,
  isExternalPackageEdge,
  type ResolvedImportPaths,
  resolveImportPaths,
  resolveTargetPackage,
  viewAllowsEdge,
} from './edge-resolution';
import { validateNamedPackages } from './edge-validation';
import { addEdge, createPackageNodeId } from './model';
import type { DependencyGraphEdgeKind } from './types';

interface EdgeCandidate {
  edgeKind: DependencyGraphEdgeKind;
  importerPackage: WorkspacePackage;
  paths: ResolvedImportPaths;
  targetPackage: WorkspacePackage;
}

interface ImportProcessingOptions {
  context: DependencyGraphCollectionContext;
  fileName: string;
  importerPackage: WorkspacePackage;
  importRecord: ImportRecord;
  project: ProjectInfo;
}

function resolveExternalCandidate(
  options: ImportProcessingOptions,
): Omit<EdgeCandidate, 'edgeKind'> | null {
  const declaredTargetPackage = findPackageForSpecifier(
    options.importRecord.specifier,
    options.context.workspacePackages,
  );
  const paths = resolveImportPaths({ ...options, declaredTargetPackage });

  if (paths === null) {
    return null;
  }

  const targetPackage = resolveTargetPackage({
    context: options.context,
    declaredTargetPackage,
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
  return viewAllowsEdge(options.context, options.edgeKind)
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
  const candidate = resolveClassifiedCandidate(options);

  if (candidate !== null) {
    addResolvedImportEdge({
      candidate,
      context: options.context,
      importRecord: options.importRecord,
    });
  }
}

function collectFileEdges(options: {
  context: DependencyGraphCollectionContext;
  fileName: string;
  project: ProjectInfo;
}): void {
  const importerPackage = options.context.workspaceLookup.findPackageForFile(
    options.fileName,
  );

  if (importerPackage === null) {
    return;
  }

  const imports = collectImportsFromFile(
    options.fileName,
    options.context.config.rootDir,
    options.context.importAnalysis,
  );

  for (const importRecord of imports) {
    processImportRecord({ ...options, importerPackage, importRecord });
  }
}

function collectProjectEdges(
  context: DependencyGraphCollectionContext,
  project: ProjectInfo,
): void {
  for (const fileName of project.ownedFileNames) {
    collectFileEdges({ context, fileName, project });
  }
}

export function collectDependencyGraphEdges(
  context: DependencyGraphCollectionContext,
): void {
  for (const project of context.projects) {
    collectProjectEdges(context, project);
  }
}
