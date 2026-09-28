import type { ImportRecord } from '../import-analysis/records';
import type { CanonicalImportResolutionEvidence } from '../import-analysis/runner';
import type { TypeEvidence } from '../type-evidence/cache';
import type {
  DeclarationReferenceRequirement,
  NativeDependencyFact,
} from '../typescript-semantic/dependency-fact';
import type {
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from './contracts';
import { createDirectDependencyEvidence } from './evidence';
import { isTypeScriptSemanticSource } from './source-evidence';

export function getDirectNativeFact(options: {
  importRecord: ImportRecord;
  request: ProjectDependencyRequest;
}): NativeDependencyFact | undefined {
  const context = isNativeRequest(options)
    ? options.request.typeScriptSemanticContext
    : undefined;
  return context?.getDependencyFact(options.importRecord);
}

export function collectAmbientNativeObservation(options: {
  evidence: CanonicalImportResolutionEvidence;
  collection: ProjectDependencyCollection;
  importRecord: ImportRecord;
  request: ProjectDependencyRequest;
}): boolean {
  const fact = getDirectNativeFact(options);
  if (fact === undefined) return false;
  return collectAmbientFact({ ...options, fact });
}

function collectAmbientFact(options: {
  request: ProjectDependencyRequest;
  evidence: CanonicalImportResolutionEvidence;
  collection: ProjectDependencyCollection;
  importRecord: ImportRecord;
  fact: NativeDependencyFact;
}): boolean {
  const { fact } = options;
  if (fact.typeEvidence.kind !== 'ambient') return false;
  if (fact.referenceRequirement !== null) return false;
  const resolutionMode = String(fact.resolution.resolutionMode);
  options.collection.observations.push({
    evidence: createDirectDependencyEvidence({
      ...options,
      nativeFact: fact,
      resolutionMode,
    }),
    importRecord: options.importRecord,
    kind: 'semantic-only',
    resolutionMode,
    typeEvidence: fact.typeEvidence,
  });
  return true;
}

function isNativeRequest(options: {
  importRecord: ImportRecord;
  request: ProjectDependencyRequest;
}): boolean {
  return (
    options.request.context.semanticAuthority.family !== 'vue' &&
    isTypeScriptSemanticSource(options.importRecord.filePath)
  );
}

export function getNativeTypeEvidence(
  fact: NativeDependencyFact | undefined,
): TypeEvidence | undefined {
  return fact?.typeEvidence;
}

export function getNativeTargetPath(
  fact: NativeDependencyFact,
): string | undefined {
  return fact.resolution.target?.resolvedFileName;
}

export function getNativeReferenceRequirement(
  fact: NativeDependencyFact | undefined,
  evidence: TypeEvidence,
): DeclarationReferenceRequirement | null {
  if (fact !== undefined) return fact.referenceRequirement;
  return evidence.kind === 'checker-source'
    ? { kind: 'source-semantic' as const, targetFileName: evidence.filePath }
    : null;
}
