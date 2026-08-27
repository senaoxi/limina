import { isBuildCapablePreset } from '#checkers';
import type { formatImportRecordLocation } from '#core/import-graph/context';
import { uniqueCodeUnitSortedStrings } from '#utils/collections';
import {
  collectProjectDependencies,
  createSourceProjectSemanticContext,
  type ProjectDependency,
} from '../project-dependencies/runner';
import {
  addAmbiguousFrameworkSourceOwnerProblem,
  addMissingFrameworkBuildOwnerProblem,
  createFrameworkDependencyEdge,
  recordFrameworkDependencyEdge,
} from './framework-dependency-edge';
import { reportUnresolvedFrameworkImport } from './framework-import-problems';
import type { ReferenceImportContext } from './reference-import-types';
import { processDeclarationProviderImport } from './reference-imports';
import type {
  GeneratedBuildModule,
  GovernedSourceUnit,
  SourceProject,
} from './types';

export interface GovernedBuildOwner {
  buildModule?: GeneratedBuildModule;
  checkerName: string;
}

type FrameworkImportRecord = Parameters<typeof formatImportRecordLocation>[1];

interface FrameworkImportOptions {
  buildOwnersByConfigPath: ReadonlyMap<string, GovernedBuildOwner>;
  context: ReferenceImportContext;
  fileName: string;
  importRecord: FrameworkImportRecord;
  projectDependency: ProjectDependency;
  project: SourceProject;
  source: GovernedSourceUnit;
}

interface OwnedResolution {
  filePath: string;
  owners: string[];
}

interface FrameworkImportTarget {
  resolution: OwnedResolution;
  targetConfigPath: string;
}

function isFrameworkFile(filePath: string): boolean {
  return filePath.endsWith('.astro') || filePath.endsWith('.svelte');
}

function createOwnedResolution(options: {
  context: ReferenceImportContext;
  resolvedFilePath: string;
}): OwnedResolution | null {
  const owners =
    options.context.fileOwnerLookup.get(options.resolvedFilePath) ?? [];
  return owners.length === 0
    ? null
    : { filePath: options.resolvedFilePath, owners };
}

function resolveFrameworkImportResolution(
  options: FrameworkImportOptions,
): OwnedResolution | null {
  const resolution = createOwnedResolution({
    context: options.context,
    resolvedFilePath: options.projectDependency.resolvedFilePath,
  });
  reportUnresolvedFrameworkImport({
    context: options.context,
    importRecord: options.importRecord,
    resolutionFound: resolution !== null,
    source: options.source,
  });
  return resolution;
}

function getUniqueTargetConfigPath(options: {
  importOptions: FrameworkImportOptions;
  resolution: OwnedResolution;
}): string | null {
  const ownerConfigPaths = uniqueCodeUnitSortedStrings(
    options.resolution.owners,
  );
  if (ownerConfigPaths.length > 1) {
    addAmbiguousFrameworkSourceOwnerProblem({
      ...options.importOptions,
      ownerConfigPaths,
      resolvedFilePath: options.resolution.filePath,
    });
    return null;
  }
  return ownerConfigPaths[0] ?? null;
}

function resolveFrameworkImportTarget(
  options: FrameworkImportOptions,
): FrameworkImportTarget | null {
  const resolution = resolveFrameworkImportResolution(options);
  if (resolution === null) return null;
  const targetConfigPath = getUniqueTargetConfigPath({
    importOptions: options,
    resolution,
  });
  if ([null, options.source.configPath].includes(targetConfigPath)) return null;
  return { resolution, targetConfigPath: targetConfigPath! };
}

function shouldRecordDeclarationProviderImport(
  source: GovernedSourceUnit,
  resolution: OwnedResolution,
): boolean {
  return (
    isBuildCapablePreset(source.primaryCheckerName) &&
    !isFrameworkFile(resolution.filePath)
  );
}

function recordFrameworkSchedulingDependency(
  importOptions: FrameworkImportOptions,
  target: FrameworkImportTarget,
): void {
  const targetOwner = importOptions.buildOwnersByConfigPath.get(
    target.targetConfigPath,
  );
  if (targetOwner === undefined) {
    addMissingFrameworkBuildOwnerProblem({
      ...importOptions,
      targetConfigPath: target.targetConfigPath,
    });
    return;
  }
  recordFrameworkDependencyEdge(
    importOptions.context,
    createFrameworkDependencyEdge({
      ...importOptions,
      resolvedFilePath: target.resolution.filePath,
      targetCheckerName: targetOwner.checkerName,
      targetConfigPath: target.targetConfigPath,
    }),
  );
}

function processFrameworkImport(options: FrameworkImportOptions): void {
  const target = resolveFrameworkImportTarget(options);
  if (target === null) return;
  if (
    shouldRecordDeclarationProviderImport(options.source, target.resolution)
  ) {
    processDeclarationProviderImport({
      ...options,
      projectDependency: options.projectDependency,
    });
    return;
  }
  recordFrameworkSchedulingDependency(options, target);
}

function getFrameworkSourceFileNames(source: GovernedSourceUnit): string[] {
  if (!isBuildCapablePreset(source.primaryCheckerName)) {
    return source.ownedFileNames;
  }
  return source.ownedFileNames.filter(isFrameworkFile);
}

interface FrameworkSourceOptions {
  buildOwnersByConfigPath: ReadonlyMap<string, GovernedBuildOwner>;
  context: ReferenceImportContext;
  primaryProjectsByConfigPath: ReadonlyMap<string, SourceProject>;
  source: GovernedSourceUnit;
}

function processFrameworkDependencies(options: {
  base: FrameworkSourceOptions;
  dependencies: ReturnType<typeof collectProjectDependencies>['dependencies'];
  frameworkFiles: ReadonlySet<string>;
  project: SourceProject;
}): void {
  for (const projectDependency of options.dependencies) {
    processFrameworkDependency({ ...options, projectDependency });
  }
}

function processFrameworkDependency(options: {
  base: FrameworkSourceOptions;
  frameworkFiles: ReadonlySet<string>;
  project: SourceProject;
  projectDependency: ProjectDependency;
}): void {
  const fileName = options.projectDependency.importRecord.filePath;
  if (!options.frameworkFiles.has(fileName)) return;
  processFrameworkImport({
    ...options.base,
    fileName,
    importRecord: options.projectDependency.importRecord,
    project: options.project,
    projectDependency: options.projectDependency,
  });
}

function processFrameworkObservations(options: {
  context: ReferenceImportContext;
  frameworkFiles: ReadonlySet<string>;
  observations: ReturnType<typeof collectProjectDependencies>['observations'];
  source: GovernedSourceUnit;
}): void {
  for (const observation of options.observations) {
    processFrameworkObservation({ ...options, observation });
  }
}

function processFrameworkObservation(options: {
  context: ReferenceImportContext;
  frameworkFiles: ReadonlySet<string>;
  observation: ReturnType<
    typeof collectProjectDependencies
  >['observations'][number];
  source: GovernedSourceUnit;
}): void {
  if (options.observation.kind !== 'missing') return;
  if (!options.frameworkFiles.has(options.observation.importRecord.filePath)) {
    return;
  }
  reportUnresolvedFrameworkImport({
    context: options.context,
    importRecord: options.observation.importRecord,
    resolutionFound: false,
    source: options.source,
  });
}

function processFrameworkSource(options: FrameworkSourceOptions): void {
  const project = options.primaryProjectsByConfigPath.get(
    options.source.configPath,
  );
  if (project === undefined) return;
  const frameworkFiles = new Set(getFrameworkSourceFileNames(options.source));
  const collection = collectProjectDependencies({
    caches: options.context.projectDependencyCaches,
    context: createSourceProjectSemanticContext({
      authority: options.source.semanticAuthority,
      project,
      source: options.source,
    }),
    importAnalysis: options.context.importAnalysis,
  });
  processFrameworkDependencies({
    base: options,
    dependencies: collection.dependencies,
    frameworkFiles,
    project,
  });
  processFrameworkObservations({
    context: options.context,
    frameworkFiles,
    observations: collection.observations,
    source: options.source,
  });
}

export function processFrameworkSourceReferences(options: {
  buildOwnersByConfigPath: ReadonlyMap<string, GovernedBuildOwner>;
  context: ReferenceImportContext;
  governedSources: readonly GovernedSourceUnit[];
  primaryProjectsByConfigPath: ReadonlyMap<string, SourceProject>;
}): void {
  for (const source of options.governedSources) {
    processFrameworkSource({ ...options, source });
  }
}
