import { createHash } from 'node:crypto';
import { cloneTypeEvidence } from '../framework-semantic/prepared-dependency';
import type { ImportRecord } from '../import-analysis/records';
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
  'service-script-facts-v3-kind-aware-typescript';

export function createProjectDependencyCaches(): ProjectDependencyCaches {
  return {
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
      importRecord: {
        ...dependency.importRecord,
        locator: { ...dependency.importRecord.locator },
      },
      typeEvidence: cloneTypeEvidence(dependency.typeEvidence),
    })),
    failures: collection.failures.map((failure) => ({
      ...failure,
      importRecord:
        failure.importRecord === undefined
          ? undefined
          : {
              ...failure.importRecord,
              locator: { ...failure.importRecord.locator },
            },
    })),
    observations: collection.observations.map(cloneObservation),
  };
}

export function cloneProjectDependencyPreparation(
  preparation: ProjectDependencyPreparation,
): ProjectDependencyPreparation {
  return {
    directSourceRecords: preparation.directSourceRecords.map((record) => ({
      ...record,
      locator: { ...record.locator },
    })),
    facts: preparation.facts.map((fact) => ({
      ...fact,
      importRecord: {
        ...fact.importRecord,
        locator: { ...fact.importRecord.locator },
      },
      target: fact.target === null ? null : { ...fact.target },
      typeEvidence: cloneTypeEvidence(fact.typeEvidence),
    })),
    failures: preparation.failures.map((failure) => ({
      ...failure,
      importRecord:
        failure.importRecord === undefined
          ? undefined
          : {
              ...failure.importRecord,
              locator: { ...failure.importRecord.locator },
            },
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
    kind: 'resource',
    typeEvidence:
      observation.typeEvidence === undefined
        ? undefined
        : (cloneTypeEvidence(observation.typeEvidence) as NonNullable<
            typeof observation.typeEvidence
          >),
  };
}

function cloneMappedObservation(
  observation: Exclude<
    ProjectDependencyObservation,
    { kind: 'unmapped-generated' }
  >,
): ProjectDependencyObservation {
  const importRecord = {
    ...observation.importRecord,
    locator: { ...observation.importRecord.locator },
  };
  if (observation.kind === 'missing') {
    return cloneMissingObservation(observation, importRecord);
  }
  return cloneResourceObservation(observation, importRecord);
}

export function cloneSourceEvidence(evidence: SourceEvidence): SourceEvidence {
  return {
    diagnostics: [...evidence.diagnostics],
    filePath: evidence.filePath,
    records: evidence.records.map((record) => ({
      ...record,
      locator: { ...record.locator },
    })),
  };
}
