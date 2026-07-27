import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import { isDeclarationFileFamily } from '../core/import-graph/declaration-provider';
import type { ManagedOutputDeclarationProvider } from '../core/import-graph/managed-output-provider';
import type { ExpectedReferenceCollectionContext } from './reference-types';

export interface ManagedResolution {
  attribution: ManagedOutputDeclarationProvider | null;
  resolvedFilePath: string;
  targetProjectPath: string | null;
}

interface ManagedOutputOptions {
  context: ExpectedReferenceCollectionContext;
  graphResolvedFilePath: string;
  importRecord: ImportRecord;
  project: ProjectInfo;
}

function isMatchingProviderEdge(options: {
  attribution: ManagedOutputDeclarationProvider;
  edge: ExpectedReferenceCollectionContext['generatedGraph']['providerEdges'][number];
  importingCheckerName: string;
  importRecord: ImportRecord;
  project: ProjectInfo;
}): boolean {
  return [
    options.edge.fromChecker === options.importingCheckerName,
    options.edge.fromConfigPath === options.project.resolverConfigPath,
    options.edge.importedSpecifier === options.importRecord.specifier,
    options.edge.resolvedFilePath === options.attribution.declarationFilePath,
    options.edge.toConfigPath === options.attribution.sourceConfigPath,
  ].every(Boolean);
}

function getProviderTargetPath(options: {
  context: ExpectedReferenceCollectionContext;
  edge: ExpectedReferenceCollectionContext['generatedGraph']['providerEdges'][number];
}): string | null {
  return (
    options.context.generatedGraph.sourceToDts
      .get(options.edge.toChecker)
      ?.get(options.edge.toConfigPath) ?? null
  );
}

function getCrossCheckerTargetForEdge(options: {
  attribution: ManagedOutputDeclarationProvider;
  context: ExpectedReferenceCollectionContext;
  edge: ExpectedReferenceCollectionContext['generatedGraph']['providerEdges'][number];
  importingCheckerName: string;
  importRecord: ImportRecord;
  project: ProjectInfo;
}): string | null {
  if (!isMatchingProviderEdge(options)) {
    return null;
  }

  return getProviderTargetPath(options);
}

function findCrossCheckerTargetProjectPath(options: {
  attribution: ManagedOutputDeclarationProvider;
  context: ExpectedReferenceCollectionContext;
  importingCheckerName: string;
  importRecord: ImportRecord;
  project: ProjectInfo;
}): string | null {
  for (const edge of options.context.generatedGraph.providerEdges) {
    const targetPath = getCrossCheckerTargetForEdge({ ...options, edge });
    if (targetPath) {
      return targetPath;
    }
  }

  return null;
}

function findManagedOutputTargetProjectPath(options: {
  attribution: ManagedOutputDeclarationProvider;
  context: ExpectedReferenceCollectionContext;
  importingCheckerName: string;
  importRecord: ImportRecord;
  project: ProjectInfo;
}): string | null {
  const sameCheckerTarget = options.context.generatedGraph.sourceToDts
    .get(options.importingCheckerName)
    ?.get(options.attribution.sourceConfigPath);
  if (sameCheckerTarget) {
    return sameCheckerTarget;
  }

  return findCrossCheckerTargetProjectPath(options);
}

function getManagedAttribution(options: ManagedOutputOptions): {
  attribution: ManagedOutputDeclarationProvider;
  importingCheckerName: string;
} | null {
  const importingCheckerName = options.context.projectCheckerNamesByPath.get(
    options.project.configPath,
  );
  if (!importingCheckerName) {
    return null;
  }

  const attribution = options.context.managedOutputLookup.resolve(
    options.graphResolvedFilePath,
    importingCheckerName,
  );
  return attribution ? { attribution, importingCheckerName } : null;
}

function createManagedResolution(
  options: ManagedOutputOptions,
): ManagedResolution | null {
  const managed = getManagedAttribution(options);
  if (!managed) {
    return null;
  }

  const targetProjectPath = findManagedOutputTargetProjectPath({
    attribution: managed.attribution,
    context: options.context,
    importingCheckerName: managed.importingCheckerName,
    importRecord: options.importRecord,
    project: options.project,
  });
  if (!targetProjectPath) {
    return null;
  }

  return {
    attribution: managed.attribution,
    resolvedFilePath: managed.attribution.mappedSourceFilePath,
    targetProjectPath,
  };
}

function createSourceResolution(
  graphResolvedFilePath: string,
): ManagedResolution {
  return {
    attribution: null,
    resolvedFilePath: graphResolvedFilePath,
    targetProjectPath: null,
  };
}

export function resolveManagedOutput(
  options: ManagedOutputOptions,
): ManagedResolution | null {
  return isDeclarationFileFamily(options.graphResolvedFilePath)
    ? createManagedResolution(options)
    : createSourceResolution(options.graphResolvedFilePath);
}
