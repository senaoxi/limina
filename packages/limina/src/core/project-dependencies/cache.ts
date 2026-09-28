import { cloneTypeEvidence } from '../framework-semantic/prepared-dependency';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeEvidence } from '../type-evidence/cache';
import type { SourceSyntaxFactsCache } from '../typescript-semantic/syntax-cache';
import type {
  ProjectDependencyCaches,
  ProjectDependencyCollection,
  ProjectDependencyObservation,
  ProjectDependencyPreparation,
  SourceEvidence,
} from './contracts';
import { cloneDependencyEvidence } from './evidence';

export {
  createProjectSemanticCacheIdentity,
  getProjectSemanticCacheIdentity,
  PROJECT_DEPENDENCY_ADAPTER_VERSION,
} from './identity';

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

export function cloneProjectDependencyCollection(
  collection: ProjectDependencyCollection,
): ProjectDependencyCollection {
  return {
    dependencies: collection.dependencies.map((dependency) => ({
      ...dependency,
      evidence: cloneDependencyEvidence(dependency.evidence),
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
      evidence: cloneDependencyEvidence(failure.evidence),
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
      evidence: cloneDependencyEvidence(failure.evidence),
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
  if (observation.kind === 'unmapped-generated')
    return {
      ...observation,
      evidence: cloneDependencyEvidence(observation.evidence),
    };
  return cloneMappedObservation(observation);
}

function cloneMissingObservation(
  observation: Extract<ProjectDependencyObservation, { kind: 'missing' }>,
  importRecord: ImportRecord,
): ProjectDependencyObservation {
  return {
    evidence: cloneDependencyEvidence(observation.evidence),
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
    evidence: cloneDependencyEvidence(observation.evidence),
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
    evidence: cloneDependencyEvidence(observation.evidence),
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
