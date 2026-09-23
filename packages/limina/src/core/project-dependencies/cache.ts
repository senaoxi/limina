import { createHash } from 'node:crypto';
import { cloneTypeEvidence } from '../framework-semantic/prepared-dependency';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeEvidence } from '../type-evidence/cache';
import type { SourceSyntaxFactsCache } from '../typescript-semantic/syntax-cache';
import type {
  ProjectDependencyCaches,
  ProjectDependencyCollection,
  ProjectDependencyObservation,
  ProjectDependencyPreparation,
  ProjectDependencyRequest,
  ProjectSemanticContext,
  SourceEvidence,
} from './contracts';

export const PROJECT_DEPENDENCY_ADAPTER_VERSION =
  'service-script-facts-v5-scope-evidence';

export function createProjectDependencyCaches(
  syntaxFacts?: SourceSyntaxFactsCache,
): ProjectDependencyCaches {
  return {
    syntaxFacts,
    pendingOwnershipEvidenceCache: new Map(),
    projectDependencyCache: new Map(),
    projectDependencyPreparationCache: new Map(),
    sourceEvidenceCache: new Map(),
    typeScriptSemanticFactsCache: new Map(),
  };
}

function getAstroCacheIdentity(context: ProjectSemanticContext): string | null {
  return context.astroSemanticProject?.seed.id ?? null;
}

function getSvelteCacheIdentity(context: ProjectSemanticContext) {
  const project = context.svelteSemanticProject;
  return project === undefined
    ? null
    : {
        adapterVersion: project.adapterVersion,
        configClosure: project.configClosure,
        packageIdentity: project.packageIdentity,
        options: project.options,
        generation: project.generation,
      };
}

function getVueCacheIdentity(context: ProjectSemanticContext): string | null {
  return context.vueSemanticIdentity?.id ?? null;
}

export function createProjectSemanticCacheIdentity(
  context: ProjectSemanticContext,
): string {
  const canonicalIdentity = JSON.stringify({
    adapterContractVersion: PROJECT_DEPENDENCY_ADAPTER_VERSION,
    astro: getAstroCacheIdentity(context),
    authority: context.semanticAuthority,
    configPath: context.configPath,
    compilerOptions: context.compilerOptions,
    references: context.references,
    fileNames: context.fileNames,
    generation: context.generation,
    packageRoots: [...context.packageRootByFileName.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    ),
    resolverConfigPath: context.resolverConfigPath,
    svelte: getSvelteCacheIdentity(context),
    vue: getVueCacheIdentity(context),
    workspaceSourceBoundary: context.workspaceSourceBoundary.identity,
  });
  return `project-dependencies:${createHash('sha256')
    .update(canonicalIdentity)
    .digest('hex')}`;
}

export function getProjectSemanticCacheIdentity(
  request: ProjectDependencyRequest,
): string {
  return (
    request.projectSemanticCacheIdentity ??
    createProjectSemanticCacheIdentity(request.context)
  );
}

export function cloneProjectDependencyCollection(
  collection: ProjectDependencyCollection,
): ProjectDependencyCollection {
  return {
    dependencies: collection.dependencies.map((dependency) => ({
      ...dependency,
      nativeFact:
        dependency.nativeFact === undefined
          ? undefined
          : structuredClone(dependency.nativeFact),
      referenceRequirement:
        dependency.referenceRequirement === null
          ? null
          : { ...dependency.referenceRequirement },
      importRecord: structuredClone(dependency.importRecord),
      typeEvidence: cloneTypeEvidence(dependency.typeEvidence),
    })),
    failures: collection.failures.map((failure) => ({
      ...failure,
      importRecord:
        failure.importRecord === undefined
          ? undefined
          : structuredClone(failure.importRecord),
    })),
    observations: collection.observations.map(cloneObservation),
  };
}

export function cloneProjectDependencyPreparation(
  preparation: ProjectDependencyPreparation,
): ProjectDependencyPreparation {
  return {
    directSourceRecords: preparation.directSourceRecords.map((record) =>
      structuredClone(record),
    ),
    facts: preparation.facts.map((fact) => ({
      ...fact,
      importRecord: structuredClone(fact.importRecord),
      target: fact.target === null ? null : { ...fact.target },
      typeEvidence: cloneTypeEvidence(fact.typeEvidence),
    })),
    failures: preparation.failures.map((failure) => ({
      ...failure,
      importRecord:
        failure.importRecord === undefined
          ? undefined
          : structuredClone(failure.importRecord),
    })),
    observations: preparation.observations.map(cloneObservation),
    ready: preparation.ready,
  };
}

function cloneObservation(
  observation: ProjectDependencyObservation,
): ProjectDependencyObservation {
  if (observation.kind === 'unmapped-generated') return { ...observation };
  return cloneMappedObservation(observation);
}

function cloneMissingObservation(
  observation: Extract<ProjectDependencyObservation, { kind: 'missing' }>,
  importRecord: ImportRecord,
): ProjectDependencyObservation {
  return {
    importRecord,
    resolutionMode: observation.resolutionMode,
    kind: 'missing',
    typeEvidence:
      observation.typeEvidence === undefined ? undefined : { kind: 'missing' },
  };
}

function cloneResourceObservation(
  observation: Extract<ProjectDependencyObservation, { kind: 'resource' }>,
  importRecord: ImportRecord,
): ProjectDependencyObservation {
  return {
    importRecord,
    resolutionMode: observation.resolutionMode,
    kind: 'resource',
    typeEvidence:
      observation.typeEvidence === undefined
        ? undefined
        : { ...observation.typeEvidence },
  };
}

function cloneSemanticOnlyObservation(
  observation: Extract<ProjectDependencyObservation, { kind: 'semantic-only' }>,
  importRecord: ImportRecord,
): ProjectDependencyObservation {
  return {
    importRecord,
    resolutionMode: observation.resolutionMode,
    kind: 'semantic-only',
    typeEvidence: cloneTypeEvidence(observation.typeEvidence) as Extract<
      TypeEvidence,
      { kind: 'ambient' }
    >,
  };
}

function cloneMappedObservation(
  observation: Exclude<
    ProjectDependencyObservation,
    { kind: 'unmapped-generated' }
  >,
): ProjectDependencyObservation {
  const importRecord = structuredClone(observation.importRecord);
  if (observation.kind === 'missing')
    return cloneMissingObservation(observation, importRecord);
  if (observation.kind === 'resource')
    return cloneResourceObservation(observation, importRecord);
  return cloneSemanticOnlyObservation(observation, importRecord);
}

export function cloneSourceEvidence(evidence: SourceEvidence): SourceEvidence {
  return {
    diagnostics: [...evidence.diagnostics],
    filePath: evidence.filePath,
    records: evidence.records.map((record) => structuredClone(record)),
  };
}
