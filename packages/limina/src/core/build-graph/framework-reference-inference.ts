import { isBuildCapablePreset } from '#checkers';
import type { formatImportRecordLocation } from '#core/import-graph/context';
import { formatImportRecordLocation as importLocation } from '#core/import-graph/context';
import { uniqueCodeUnitSortedStrings } from '#utils/collections';
import { collectFrameworkExecutionInputs } from '../analysis-cache/framework-execution-inputs';
import { effectiveReferenceInputs } from '../project-dependencies/declaration-projection';
import {
  collectProjectDependencies,
  createSourceProjectSemanticContext,
  type ProjectDependency,
} from '../project-dependencies/runner';
import { observeSvelteNativeComponentRequests } from '../svelte-semantic/generated-script';
import { createSvelteModuleTarget } from '../svelte-semantic/module-resolution';
import { resolveSvelteSemanticToolchain } from '../svelte-semantic/toolchain';
import { shouldUseDeclarationProvider } from './compilation-prerequisite';
import {
  addAmbiguousFrameworkSourceOwnerProblem,
  addMissingFrameworkBuildOwnerProblem,
  createFrameworkDependencyEdge,
  hasFrameworkCompilationRequirement,
  recordFrameworkDependencyEdge,
} from './framework-dependency-edge';
import {
  isFrameworkContribution,
  reportUnresolvedFrameworkImport,
} from './framework-import-problems';
import { nativeFrameworkTarget } from './native-framework-target';
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
  const evidence = options.projectDependency.nativeFact?.nativeEvidence;
  return evidence === undefined
    ? resolveLegacyFrameworkTarget(options)
    : nativeFrameworkTarget(options, evidence);
}

function resolveLegacyFrameworkTarget(
  options: FrameworkImportOptions,
): FrameworkImportTarget | null {
  const resolution = resolveFrameworkImportResolution(options);
  if (resolution === null) return null;
  const targetConfigPath = getUniqueTargetConfigPath({
    importOptions: options,
    resolution,
  });
  return [null, options.source.configPath].includes(targetConfigPath)
    ? null
    : { resolution, targetConfigPath: targetConfigPath! };
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
    shouldUseDeclarationProvider(options.source, target.resolution.filePath)
  ) {
    processDeclarationProviderImport({
      ...options,
      projectDependency: options.projectDependency,
    });
    return;
  }
  recordFrameworkSchedulingDependency(options, target);
}

function getFrameworkSourceFileNames(
  source: GovernedSourceUnit,
  project: SourceProject,
): string[] {
  return isBuildCapablePreset(source.primaryCheckerName)
    ? source.ownedFileNames.filter(isFrameworkFile)
    : project.fileNames;
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
  if (
    options.base.context.svelteConsumerView !== undefined &&
    options.base.source.primaryCheckerName === 'svelte-check' &&
    options.projectDependency.targetKind === 'source' &&
    !options.project.options.noResolve
  ) {
    const target = resolveLegacyFrameworkTarget({
      ...options.base,
      fileName: options.projectDependency.importRecord.filePath,
      importRecord: options.projectDependency.importRecord,
      project: options.project,
      projectDependency: options.projectDependency,
    });
    if (target !== null)
      recordFrameworkSchedulingDependency(
        {
          ...options.base,
          fileName: options.projectDependency.importRecord.filePath,
          importRecord: options.projectDependency.importRecord,
          project: options.project,
          projectDependency: options.projectDependency,
        },
        target,
      );
    return;
  }
  if (!hasFrameworkCompilationRequirement(options.projectDependency)) return;
  const fileName = options.projectDependency.importRecord.filePath;
  if (!isFrameworkContribution({ ...options, context: options.base.context }))
    return;
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
  if (
    options.observation.kind !== 'missing' ||
    !options.frameworkFiles.has(options.observation.importRecord.filePath)
  ) {
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
  const frameworkFiles = new Set(
    getFrameworkSourceFileNames(options.source, project),
  );
  const collection = collectFrameworkExecutionInputs(
    {
      source: options.source,
      project,
      analysis: options.context.importAnalysis,
    },
    () => {
      const semantic = options.source.svelteSemanticProject;
      if (
        semantic !== undefined &&
        options.context.svelteConsumerView !== undefined
      ) {
        const toolchain = resolveSvelteSemanticToolchain(
          semantic.packageRootDir,
        );
        for (const request of observeSvelteNativeComponentRequests(
          semantic,
          toolchain,
        )) {
          const target = createSvelteModuleTarget(
            request.raw?.resolvedModule,
            toolchain.tsModule,
          );
          if (target?.resolvedBy !== 'checker-source') continue;
          const owners =
            options.context.fileOwnerLookup.get(target.resolvedFileName) ?? [];
          if (owners.length !== 1)
            throw new Error(
              `Svelte Compiler request has no unique owner: ${request.record.specifier}`,
            );
          const owner = options.buildOwnersByConfigPath.get(owners[0]!)!;
          if (owners[0] !== options.source.configPath)
            recordFrameworkDependencyEdge(
              options.context,
              createFrameworkDependencyEdge({
                context: options.context,
                source: options.source,
                importRecord: request.record,
                resolvedFilePath: target.resolvedFileName,
                targetCheckerName: owner.checkerName,
                targetConfigPath: owners[0]!,
              }),
            );
        }
      }
      return collectProjectDependencies({
        compilationObligationScope: 'generated-declaration-project-v1',
        caches: options.context.projectDependencyCaches,
        context: createSourceProjectSemanticContext({
          authority: options.source.semanticAuthority,
          project,
          source: options.source,
          workspaceSourceBoundary: options.context.workspaceSourceBoundary,
        }),
        importAnalysis: options.context.importAnalysis,
      });
    },
  );
  if (options.source.primaryCheckerName === 'svelte-check') {
    for (const dependency of collection.dependencies) {
      if (dependency.targetKind !== 'declaration') continue;
      const bindings = options.context.svelteConsumerView?.bindings;
      const binding =
        bindings?.get(dependency.resolvedFilePath) ??
        [...(bindings?.values() ?? [])].find(
          (entry) => entry.outputFile === dependency.resolvedFilePath,
        );
      if (binding === undefined) continue;
      const edge = {
        kind: 'framework-declaration' as const,
        file: importLocation(
          options.context.config.rootDir,
          dependency.importRecord,
        ),
        fromChecker: options.source.primaryCheckerName,
        fromConfigPath: options.source.configPath,
        importedSpecifier: dependency.importRecord.specifier,
        resolvedFilePath: dependency.resolvedFilePath,
        toChecker: binding.checker,
        toConfigPath: binding.sourceConfig,
      };
      options.context.dependencyEdgesByKey.set(JSON.stringify(edge), edge);
    }
  }
  processFrameworkDependencies({
    base: options,
    dependencies:
      options.context.svelteConsumerView === undefined
        ? effectiveReferenceInputs(collection)
        : collection.dependencies,
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
