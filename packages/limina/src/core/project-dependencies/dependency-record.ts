import { normalizeAbsolutePath } from '#utils/path';
import type { PreparedDependencyFact } from '../framework-semantic/contracts';
import { cloneTypeEvidence } from '../framework-semantic/prepared-dependency';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { TypeEvidence } from '../type-evidence/cache';
import type {
  MappedSourceDependency,
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from './contracts';
import { createProjectDependencyFailure } from './failure';
import { isTypeScriptSemanticSource } from './source-evidence';

export { collectProjectDependencyRecord } from './direct-dependency-record';

interface CollectFactOptions {
  collection: ProjectDependencyCollection;
  fact: PreparedDependencyFact;
  request: ProjectDependencyRequest;
}

function getTargetKind(
  resolvedFilePath: string,
): MappedSourceDependency['targetKind'] {
  return isDeclarationFile(resolvedFilePath) ? 'declaration' : 'source';
}

function isNativeProjectDependencyTarget(resolvedFilePath: string): boolean {
  return (
    isDeclarationFile(resolvedFilePath) ||
    isTypeScriptSemanticSource(resolvedFilePath)
  );
}

function isFrameworkProjectTarget(options: {
  fact: PreparedDependencyFact;
  request: ProjectDependencyRequest;
}): boolean {
  const target = options.fact.target;
  if (target === null) return false;
  return isResolvedFrameworkTarget(options, target);
}

function isResolvedFrameworkTarget(
  options: {
    fact: PreparedDependencyFact;
    request: ProjectDependencyRequest;
  },
  target: NonNullable<PreparedDependencyFact['target']>,
): boolean {
  if (isNativeProjectDependencyTarget(target.resolvedFileName)) return true;
  if (target.resolvedBy === 'checker-source') return true;
  return hasFrameworkExtension(options);
}

function hasFrameworkExtension(options: {
  fact: PreparedDependencyFact;
  request: ProjectDependencyRequest;
}): boolean {
  const target = options.fact.target!;
  const normalized = target.resolvedFileName.toLowerCase();
  return options.request.context.extensions.some((extension) =>
    normalized.endsWith(extension.toLowerCase()),
  );
}

function getEvidenceTargetPath(evidence: TypeEvidence): string | null {
  if (evidence.kind === 'checker-source') return evidence.filePath;
  if (evidence.kind === 'concrete-declaration') return evidence.filePath;
  return null;
}

function evidenceKindMatchesTarget(
  evidence: TypeEvidence,
  targetPath: string,
): boolean {
  return isDeclarationFile(targetPath)
    ? evidence.kind === 'concrete-declaration'
    : evidence.kind === 'checker-source';
}

function physicalEvidenceMatchesTarget(
  evidence: TypeEvidence,
  target: NonNullable<PreparedDependencyFact['target']>,
): boolean {
  const evidencePath = getEvidenceTargetPath(evidence);
  if (evidencePath === null) return false;
  const targetPath = normalizeAbsolutePath(target.resolvedFileName);
  if (normalizeAbsolutePath(evidencePath) !== targetPath) return false;
  return evidenceKindMatchesTarget(evidence, targetPath);
}

function evidenceMatchesTarget(fact: PreparedDependencyFact): boolean {
  const target = fact.target;
  const evidence = fact.typeEvidence;
  if (target === null) {
    return ['ambient', 'missing'].includes(evidence.kind);
  }
  return physicalEvidenceMatchesTarget(evidence, target);
}

function addFactFailure(options: CollectFactOptions, reason: string): void {
  options.collection.failures.push(
    createProjectDependencyFailure({
      identity: JSON.stringify({
        filePath: options.fact.importRecord.filePath,
        framework: options.fact.framework,
        kind: options.fact.importRecord.kind,
        locator: options.fact.importRecord.locator,
        stage: 'prepared-fact-classification',
      }),
      importRecord: options.fact.importRecord,
      reason,
      request: options.request,
      stage: 'module-resolution',
    }),
  );
}

function addMappedDependency(options: CollectFactOptions): void {
  const target = options.fact.target!;
  const resolvedFilePath = normalizeAbsolutePath(target.resolvedFileName);
  const dependency: MappedSourceDependency = {
    framework: options.fact.framework,
    importRecord: options.fact.importRecord,
    provenance: 'strict-source-map',
    resolutionMode: options.fact.resolutionMode,
    resolvedFilePath,
    semanticSpecifier: options.fact.semanticSpecifier,
    targetKind: getTargetKind(resolvedFilePath),
    typeEvidence: cloneTypeEvidence(options.fact.typeEvidence),
  };
  options.collection.dependencies.push(dependency);
}

function validatePreparedFact(options: CollectFactOptions): string | null {
  if (options.fact.typeEvidence.kind === 'unsupported-checker') {
    return options.fact.typeEvidence.reason;
  }
  if (!evidenceMatchesTarget(options.fact)) {
    return 'Prepared framework dependency target and TypeEvidence do not describe the same semantic result.';
  }
  return null;
}

function addTargetedFact(options: CollectFactOptions): boolean {
  if (options.fact.target === null) return false;
  if (isFrameworkProjectTarget(options)) {
    addMappedDependency(options);
    return true;
  }
  return addTypedTargetObservation(options);
}

function addTypedTargetObservation(options: CollectFactOptions): boolean {
  const evidence = options.fact.typeEvidence;
  if (evidence.kind !== 'checker-source') return false;
  options.collection.observations.push({
    importRecord: options.fact.importRecord,
    kind: 'resource',
    typeEvidence: { ...evidence },
  });
  return true;
}

function addTargetlessFact(options: CollectFactOptions): void {
  if (options.fact.typeEvidence.kind === 'ambient') {
    options.collection.observations.push({
      importRecord: options.fact.importRecord,
      kind: 'resource',
      typeEvidence: cloneTypeEvidence(options.fact.typeEvidence) as Extract<
        TypeEvidence,
        { kind: 'ambient' }
      >,
    });
    return;
  }
  if (options.fact.typeEvidence.kind === 'missing') {
    options.collection.observations.push({
      importRecord: options.fact.importRecord,
      kind: 'missing',
      typeEvidence: { kind: 'missing' },
    });
    return;
  }
  addFactFailure(
    options,
    'Prepared framework dependency could not be classified without semantic target rescue.',
  );
}

export function collectPreparedProjectDependencyFact(
  options: CollectFactOptions,
): void {
  const failure = validatePreparedFact(options);
  if (failure !== null) {
    addFactFailure(options, failure);
    return;
  }
  if (addTargetedFact(options)) return;
  addTargetlessFact(options);
}
