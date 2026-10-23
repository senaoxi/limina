import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import {
  deriveNativeCoverage,
  type NativeCoverage,
} from '../../domain/analysis/native-coverage';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type { BoundedEvidenceIndex } from './bounded-evidence-index';
import type { NativeContextRecord } from './contracts';

export function hasBoundObligations(
  record: NativeContextRecord,
  context: NativeEvidenceContext,
  index: BoundedEvidenceIndex,
): boolean {
  const { obligations, requests } = record.native!.snapshot;
  const ids = obligations.flatMap((obligation) => obligation.requestIds);
  return (
    ids.length === requests.length &&
    new Set(ids).size === ids.length &&
    obligations.every((obligation) =>
      hasBoundObligation({ record, index }, context, obligation),
    )
  );
}
function hasBoundObligation(
  input: { record: NativeContextRecord; index: BoundedEvidenceIndex },
  context: NativeEvidenceContext,
  obligation: NativeCompilationObligation,
): boolean {
  const { record, index } = input;
  // This adapter emits one audited occurrence per obligation. Generic compiler
  // observation identities belong to a different producer provenance contract.
  if (obligation.requestIds.length !== 1) return false;
  const requestId = obligation.requestIds[0]!;
  return [
    index.requests.get(requestId)?.consumerContextId === context.id,
    obligation.id === nativeFingerprint(['compilation-obligation', requestId]),
    obligation.consumerContextId === context.id,
    obligation.consumerConfigId === context.inputs.config,
    obligation.rawReferenceFingerprint === context.inputs.rawReferences,
    hasBoundExistence(obligation),
    hasBoundTarget(record, obligation, index),
  ].every(Boolean);
}
function hasBoundTarget(
  record: NativeContextRecord,
  obligation: NativeCompilationObligation,
  index: BoundedEvidenceIndex,
): boolean {
  // A compiler Reference Map endpoint can legitimately differ from Coverage.
  // Without references, a claimed endpoint must come from this resolution.
  return (
    [
      obligation.targetConfigId === null,
      (record.project.projectReferences ?? []).length > 0,
    ].some(Boolean) || hasCoveredTarget(record, obligation, index)
  );
}
function hasCoveredTarget(
  record: NativeContextRecord,
  obligation: NativeCompilationObligation,
  index: BoundedEvidenceIndex,
): boolean {
  const snapshot = record.native!.snapshot;
  const resolution = index.resolutions.get(obligation.requestIds[0]!);
  if (resolution?.target == null) return false;
  const coverage = deriveNativeCoverage(
    snapshot.coverageIndexes[0]!,
    resolution.target,
  );
  return hasMatchingTargetConfig(coverage, obligation.targetConfigId);
}
function hasMatchingTargetConfig(
  coverage: NativeCoverage,
  targetConfigId: string | null,
): boolean {
  return (
    coverage.state === 'unique' &&
    coverage.members[0]!.configId === targetConfigId
  );
}
function hasBoundExistence(obligation: NativeCompilationObligation): boolean {
  const existence = obligation.existence;
  if (existence.state === 'unknown') return true;
  return [
    existence.proof.kind === 'audited-rule',
    existence.proof.evidenceId === obligation.requestIds[0],
    existence.proof.contextId === obligation.consumerContextId,
  ].every(Boolean);
}
