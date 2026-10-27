import { normalizeAbsolutePath } from '#utils/path';
import {
  decideReferenceRequirement,
  type DeclarationReferenceRequirement,
  pendingRequirementReason,
} from '../dependency-semantics';
import type { PreparedDependencyFact } from '../framework-semantic/contracts';
import { cloneTypeEvidence } from '../framework-semantic/prepared-dependency';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { TypeEvidence } from '../type-evidence/cache';
import type {
  ProjectDependency,
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from './contracts';
import { createPreparedDependencyEvidence } from './evidence';
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
): ProjectDependency['targetKind'] {
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
  return target !== null && isResolvedFrameworkTarget(options, target);
}

function isResolvedFrameworkTarget(
  options: {
    fact: PreparedDependencyFact;
    request: ProjectDependencyRequest;
  },
  target: NonNullable<PreparedDependencyFact['target']>,
): boolean {
  return (
    isNativeProjectDependencyTarget(target.resolvedFileName) ||
    target.resolvedBy === 'checker-source' ||
    hasFrameworkExtension(options)
  );
}

function hasFrameworkExtension(options: {
  fact: PreparedDependencyFact;
  request: ProjectDependencyRequest;
}): boolean {
  const target = options.fact.target!;
  const normalized = target.resolvedFileName.toLowerCase();
  // Vue discovery includes native JSON resources. That extension does not
  // identify a framework service script or a declaration-producing project.
  return (
    !(options.fact.framework === 'vue' && normalized.endsWith('.json')) &&
    options.request.context.extensions.some((extension) =>
      normalized.endsWith(extension.toLowerCase()),
    )
  );
}

function addFactFailure(options: CollectFactOptions, reason: string): void {
  options.collection.failures.push(
    createProjectDependencyFailure({
      evidence: createPreparedDependencyEvidence(options),
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

function addMappedDependency(
  options: CollectFactOptions,
  requirement: DeclarationReferenceRequirement | null,
): void {
  const target = options.fact.target!;
  const resolvedFilePath = normalizeAbsolutePath(target.resolvedFileName);
  const dependency: ProjectDependency = {
    evidence: createPreparedDependencyEvidence(options),
    framework: options.fact.framework,
    importRecord: options.fact.importRecord,
    provenance: options.fact.provenance,
    referenceRequirement: requirement,
    resolutionMode: options.fact.resolutionMode,
    resolvedFilePath,
    semanticSpecifier: options.fact.semanticSpecifier,
    targetKind: getTargetKind(resolvedFilePath),
    typeEvidence: cloneTypeEvidence(options.fact.typeEvidence),
  };
  options.collection.dependencies.push(dependency);
}

function isAddTypedTargetObservation(options: CollectFactOptions): boolean {
  const evidence = options.fact.typeEvidence;
  if (evidence?.kind !== 'checker-source') return false;
  options.collection.observations.push({
    evidence: createPreparedDependencyEvidence(options),
    importRecord: options.fact.importRecord,
    resolutionMode: options.fact.resolutionMode,
    kind: 'resource',
    typeEvidence: { ...evidence },
  });
  return true;
}

function addTargetlessFact(options: CollectFactOptions): void {
  const typeEvidence = options.fact.typeEvidence;
  if (typeEvidence === undefined) {
    options.collection.observations.push({
      evidence: createPreparedDependencyEvidence(options),
      importRecord: options.fact.importRecord,
      resolutionMode: options.fact.resolutionMode,
      kind: 'missing',
    });
    return;
  }
  addObservedTargetlessFact(options, typeEvidence);
}
function addObservedTargetlessFact(
  options: CollectFactOptions,
  typeEvidence: TypeEvidence,
): void {
  if (typeEvidence.kind === 'ambient') {
    options.collection.observations.push({
      evidence: createPreparedDependencyEvidence(options),
      importRecord: options.fact.importRecord,
      resolutionMode: options.fact.resolutionMode,
      kind: 'semantic-only',
      typeEvidence: {
        ...typeEvidence,
        declarationFilePaths: [...typeEvidence.declarationFilePaths],
      },
    });
    return;
  }
  if (typeEvidence.kind === 'missing') {
    options.collection.observations.push({
      evidence: createPreparedDependencyEvidence(options),
      importRecord: options.fact.importRecord,
      resolutionMode: options.fact.resolutionMode,
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
  if (isFrameworkProjectTarget(options)) collectDecidedFact(options);
  else collectFactTarget(options, null);
}
function collectDecidedFact(options: CollectFactOptions): void {
  const decision = decideReferenceRequirement({
    ...options.fact,
    requireCompilationObligation: options.fact.framework === 'vue',
  });
  if (isRecordPendingFact(options, decision)) return;
  if (decision.state === 'decided') collectFactTarget(options, decision.value);
}
function isRecordPendingFact(
  options: CollectFactOptions,
  decision: ReturnType<typeof decideReferenceRequirement>,
): boolean {
  if (decision.state !== 'pending') return false;
  options.collection.failures.push(
    createProjectDependencyFailure({
      evidence: createPreparedDependencyEvidence(options),
      decision,
      importRecord: options.fact.importRecord,
      request: options.request,
      stage: 'dependency-semantics',
      reason: pendingRequirementReason(decision),
    }),
  );
  return true;
}
function collectFactTarget(
  options: CollectFactOptions,
  requirement: DeclarationReferenceRequirement | null,
): void {
  if (isFrameworkProjectTarget(options)) {
    addMappedDependency(options, requirement);
    return;
  }
  if (isResourceObservation(options)) return;
  addTargetlessFact(options);
}
function isResourceObservation(options: CollectFactOptions): boolean {
  return options.fact.target !== null && isAddTypedTargetObservation(options);
}
