import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import {
  findPackageForSpecifier,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import {
  collectProjectDependencies,
  createParsedProjectSemanticContext,
  type ProjectDependency,
} from '../core/project-dependencies/runner';
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
  projectDependency: ProjectDependency;
  project: ProjectInfo;
}

function resolveExternalCandidate(
  options: ImportProcessingOptions,
): Omit<EdgeCandidate, 'edgeKind'> | null {
  const declaredTargetPackage = findPackageForSpecifier(
    options.importRecord.specifier,
    options.context.workspacePackages,
  );
  const paths = resolveImportPaths({
    projectDependency: options.projectDependency,
  });

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

function collectProjectEdges(
  context: DependencyGraphCollectionContext,
  project: ProjectInfo,
): void {
  const authority = getDependencyGraphAuthority(context, project);
  if (authority === null) {
    return;
  }
  const collection = collectDependencyGraphProject({
    authority,
    context,
    project,
  });
  collectDependencyGraphFailures(context, collection.failures);
  collectDependencyGraphDependencies({ collection, context, project });
}

function getDependencyGraphAuthority(
  context: DependencyGraphCollectionContext,
  project: ProjectInfo,
) {
  const authority = project.semanticAuthority;
  if (authority === undefined) {
    context.problems.push(
      `Missing frozen semantic authority for dependency graph project ${project.configPath}.`,
    );
    return null;
  }
  return authority;
}

function collectDependencyGraphProject(options: {
  authority: NonNullable<ProjectInfo['semanticAuthority']>;
  context: DependencyGraphCollectionContext;
  project: ProjectInfo;
}) {
  const owner = options.context.workspaceLookup.findPackageForFile(
    options.project.configPath,
  );
  const packageRootDir =
    owner === null ? options.context.config.rootDir : owner.directory;
  return collectProjectDependencies({
    caches: options.context.projectDependencyCaches,
    context: createParsedProjectSemanticContext({
      authority: options.authority,
      packageRootDir,
      project: options.project,
    }),
    importAnalysis: options.context.importAnalysis,
    resolveWorkspaceTypeScriptExport: (specifier) =>
      options.context.workspaceExports.get(
        options.project.configPath,
        specifier,
      )?.typeScriptResolvedFileName ?? null,
  });
}

function collectDependencyGraphFailures(
  context: DependencyGraphCollectionContext,
  failures: ReturnType<typeof collectProjectDependencies>['failures'],
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

function collectDependencyGraphDependencies(options: {
  collection: ReturnType<typeof collectProjectDependencies>;
  context: DependencyGraphCollectionContext;
  project: ProjectInfo;
}): void {
  for (const projectDependency of options.collection.dependencies) {
    const fileName = projectDependency.importRecord.filePath;
    const importerPackage =
      options.context.workspaceLookup.findPackageForFile(fileName);
    if (importerPackage === null) continue;
    processImportRecord({
      context: options.context,
      fileName,
      importerPackage,
      importRecord: projectDependency.importRecord,
      project: options.project,
      projectDependency,
    });
  }
}

export function collectDependencyGraphEdges(
  context: DependencyGraphCollectionContext,
): void {
  for (const project of context.projects) {
    collectProjectEdges(context, project);
  }
}
