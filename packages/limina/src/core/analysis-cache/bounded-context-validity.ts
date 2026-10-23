import { nativeCollectionStatus } from '../../domain/analysis/native-collection';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { NativeResolution } from '../../domain/analysis/native-evidence';
import { summarizeCompilationObligation } from '../../domain/analysis/native-obligation';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { NATIVE_PROGRAM_ADAPTER } from '../typescript-semantic/native-program-api';
import { BoundedEvidenceIndex } from './bounded-evidence-index';
import { hasCompleteBoundedInventory } from './bounded-inventory-validity';
import { hasBoundObligations } from './bounded-obligation-validity';
import { hasBoundCompilerObservations } from './bounded-observation-validity';
import type {
  ImporterRecord,
  NativeContextRecord,
  ProjectRecord,
} from './contracts';
import { hasBoundPathSelections } from './native-path-validity';

/**
Storage checksums protect bytes; these joins protect their context meaning.
An old/partial DTO cannot obtain the new producer's consumer qualification.
*/
export function hasValidBoundedContext(
  record: NativeContextRecord,
  importers: Record<string, ImporterRecord>,
  binding: { project: ProjectRecord | undefined; contextId: string },
): boolean {
  return record.native === undefined
    ? record.project.admissionMode !== 'coverage-bounded'
    : hasQualifiedBoundedInventory(record, importers, binding);
}

function hasQualifiedBoundedInventory(
  record: NativeContextRecord,
  importers: Record<string, ImporterRecord>,
  binding: { project: ProjectRecord | undefined; contextId: string },
): boolean {
  const index = new BoundedEvidenceIndex(record.native!.snapshot);
  return (
    hasValidBoundedProof(record, index) &&
    hasBoundCompilerObservations(record, importers) &&
    [
      hasCompleteBoundedInventory({ record, importers, ...binding }),
      hasValidBoundedFacts(record, importers, index),
    ].every(Boolean)
  );
}

function hasValidBoundedProof(
  record: NativeContextRecord,
  index: BoundedEvidenceIndex,
): boolean {
  const snapshot = record.native!.snapshot;
  return (
    [snapshot.contexts.length, snapshot.coverageIndexes.length].every(
      (length) => length === 1,
    ) && hasConsistentBoundedProof(record, index)
  );
}

function hasConsistentBoundedProof(
  record: NativeContextRecord,
  index: BoundedEvidenceIndex,
): boolean {
  const snapshot = record.native!.snapshot;
  const context = snapshot.contexts[0]!;
  const contextFingerprint = nativeFingerprint(context);
  return [
    record.project.admissionMode === 'coverage-bounded',
    hasBoundPathSelections(snapshot),
    !record.complete || hasCompletedCollection(record),
    hasCompleteResolutions(record),
    context.id ===
      nativeFingerprint([
        context.inputs,
        context.epoch,
        context.collectionId,
        context.authority,
      ]),
    context.authority.phase === record.project.analysisBinding?.phase,
    hasMatchingProjectInputs(record, context),
    snapshot.requests.every(
      (request) =>
        request.consumerContextId === context.id &&
        nativeFingerprint(request.origin.context) === contextFingerprint,
    ),
    hasBoundObligations(record, context, index),
  ].every(Boolean);
}

function hasCompletedCollection(record: NativeContextRecord): boolean {
  const status = nativeCollectionStatus(record.native!.snapshot);
  return (
    status.execution === 'completed' &&
    status.traversal === 'complete-within-boundary'
  );
}

function hasCompleteResolutions(record: NativeContextRecord): boolean {
  const { requests, resolutions } = record.native!.snapshot;
  const ids = new Set(requests.map((request) => request.id));
  const resolved = new Set(
    resolutions.map((resolution) => resolution.requestId),
  );
  return [
    ids.size === requests.length,
    resolved.size === resolutions.length,
    ids.size === resolved.size,
    resolved.isSubsetOf(ids),
  ].every(Boolean);
}

function hasMatchingProjectInputs(
  record: NativeContextRecord,
  context: NativeEvidenceContext,
): boolean {
  const { project } = record;
  const expected = {
    config: project.configPath,
    roots: nativeFingerprint(project.fileNames),
    options: nativeFingerprint(effectiveCompilerOptions(project.options)),
    rawReferences: nativeFingerprint(project.projectReferences ?? []),
    compilationScope: project.compilationObligationScope ?? 'source-options',
    coverage: nativeFingerprint(record.native!.snapshot.coverageIndexes[0]),
    hostContract: NATIVE_PROGRAM_ADAPTER,
    typescriptVersion: '6.0.3',
  };
  return Object.entries(expected).every(
    ([key, value]) => context.inputs[key as keyof typeof expected] === value,
  );
}

function hasValidBoundedFacts(
  record: NativeContextRecord,
  importers: Record<string, ImporterRecord>,
  index: BoundedEvidenceIndex,
): boolean {
  return Object.values(record.sources).every((source) => {
    if (source === null) return false;
    const importer = importers[source];
    return (
      importer !== undefined &&
      Object.values(importer.facts).every((fact) =>
        hasValidBoundedFact(fact, index),
      )
    );
  });
}

function hasValidBoundedFact(
  fact: NativeDependencyFact,
  index: BoundedEvidenceIndex,
): boolean {
  const evidence = fact.nativeEvidence;
  if (evidence === undefined) return false;
  const request = index.requests.get(evidence.requestId);
  const resolution = index.resolutions.get(evidence.requestId);
  if ([request, resolution].includes(undefined)) return false;
  return hasMatchingFactEvidence(
    {
      evidence,
      request: request!,
      resolution: resolution!,
      fact,
    },
    index,
  );
}

function hasMatchingFactEvidence(
  input: {
    evidence: NonNullable<NativeDependencyFact['nativeEvidence']>;
    request: NonNullable<
      NativeContextRecord['native']
    >['snapshot']['requests'][number];
    resolution: NativeResolution;
    fact: NativeDependencyFact;
  },
  index: BoundedEvidenceIndex,
): boolean {
  const { evidence, request, resolution, fact } = input;
  const expectedCoverage =
    resolution.target === null ? null : index.coverage(resolution.target);
  return [
    nativeFingerprint(request.origin) === nativeFingerprint(evidence.origin),
    hasMatchingResolvedTarget(resolution, fact),
    nativeFingerprint(evidence.coverage) ===
      nativeFingerprint(expectedCoverage),
    hasMatchingObligation(index, evidence),
    hasProvenReferenceRequirement(fact),
  ].every(Boolean);
}

function hasProvenReferenceRequirement(fact: NativeDependencyFact): boolean {
  const obligation = fact.nativeEvidence!.obligation;
  const isRequired =
    obligation !== null &&
    summarizeCompilationObligation(obligation) === 'required';
  const expected = isRequired ? requiredReference(fact) : null;
  return (
    nativeFingerprint(fact.referenceRequirement) === nativeFingerprint(expected)
  );
}

function requiredReference(fact: NativeDependencyFact) {
  return {
    kind: 'compiler-membership',
    targetFileName: fact.resolution.target?.resolvedFileName,
  };
}

function hasMatchingResolvedTarget(
  resolution: NativeResolution,
  fact: NativeDependencyFact,
): boolean {
  const observed =
    resolution.target === null ? null : resolution.target.lexicalPath;
  const retained =
    fact.resolution.target === null
      ? null
      : fact.resolution.target.resolvedFileName;
  return observed === retained;
}

function hasMatchingObligation(
  index: BoundedEvidenceIndex,
  evidence: NonNullable<NativeDependencyFact['nativeEvidence']>,
): boolean {
  const expected = index.obligations.get(evidence.requestId) ?? null;
  return nativeFingerprint(expected) === nativeFingerprint(evidence.obligation);
}
