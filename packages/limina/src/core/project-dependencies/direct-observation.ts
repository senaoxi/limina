import {
  decideReferenceRequirement,
  pendingRequirementReason,
  type RequirementDecision,
} from '../dependency-semantics';
import type { CanonicalImportResolutionEvidence } from '../import-analysis/runner';
import type { TypeEvidence } from '../type-evidence/cache';
import type { CollectRecordOptions } from './direct-dependency-record';
import { createDirectDependencyEvidence } from './evidence';
import { createProjectDependencyFailure } from './failure';
import { getDirectNativeFact } from './native-dependency';
import { getDirectResolutionMode } from './resolution-mode';
interface DirectObservation {
  typeEvidence?: TypeEvidence;
  decision: RequirementDecision;
}
function checkerTarget(evidence: CanonicalImportResolutionEvidence) {
  return evidence.semanticEvidence === undefined
    ? evidence.typeScriptResolution
    : evidence.semanticEvidence.target;
}
export function observeDirectRequirement(
  options: CollectRecordOptions,
  evidence: CanonicalImportResolutionEvidence,
): DirectObservation {
  const nativeFact = getDirectNativeFact(options);
  if (nativeFact !== undefined)
    return {
      typeEvidence: nativeFact.typeEvidence,
      decision: { state: 'decided', value: nativeFact.referenceRequirement },
    };
  const target = checkerTarget(evidence);
  return target === null
    ? { decision: decideReferenceRequirement({ target }) }
    : queryDirectRequirement(options, evidence);
}
function queryDirectRequirement(
  options: CollectRecordOptions,
  evidence: CanonicalImportResolutionEvidence,
): DirectObservation {
  const observed = options.request.importAnalysis.observeCheckerDependency?.({
    importRecord: options.importRecord,
    resolution: evidence,
    context: {
      checkerPresets: [],
      extensions: [...options.request.context.extensions],
      semanticFamily: options.request.context.semanticAuthority.family,
      vueSemanticIdentity: options.request.context.vueSemanticIdentity,
    },
  });
  return {
    decision: decideReferenceRequirement({
      target: checkerTarget(evidence),
      ...observed,
    }),
  };
}
function directEvidence(
  options: CollectRecordOptions,
  evidence: CanonicalImportResolutionEvidence,
) {
  return createDirectDependencyEvidence({
    ...options,
    evidence,
    nativeFact: getDirectNativeFact(options),
    resolutionMode: getDirectResolutionMode({ ...options, evidence }),
  });
}
export function isRecordPendingRequirement(
  options: CollectRecordOptions,
  evidence: CanonicalImportResolutionEvidence,
  observed: DirectObservation,
): boolean {
  if (observed.decision.state !== 'pending') return false;
  options.collection.failures.push(
    createProjectDependencyFailure({
      evidence: directEvidence(options, evidence),
      decision: observed.decision,
      importRecord: options.importRecord,
      request: options.request,
      stage: 'dependency-semantics',
      reason: pendingRequirementReason(observed.decision),
    }),
  );
  return true;
}
export function isRecordAmbientObservation(
  options: CollectRecordOptions,
  evidence: CanonicalImportResolutionEvidence,
  observed: DirectObservation,
): boolean {
  return (
    isDecidedWithoutRequirement(observed) &&
    isAddAmbientObservation(options, evidence, observed.typeEvidence)
  );
}
function isAddAmbientObservation(
  options: CollectRecordOptions,
  evidence: CanonicalImportResolutionEvidence,
  typeEvidence: TypeEvidence | undefined,
): boolean {
  if (typeEvidence?.kind !== 'ambient') return false;
  options.collection.observations.push({
    evidence: directEvidence(options, evidence),
    importRecord: options.importRecord,
    resolutionMode: getDirectResolutionMode({ ...options, evidence }),
    kind: 'semantic-only',
    typeEvidence,
  });
  return true;
}

function isDecidedWithoutRequirement(observed: DirectObservation): boolean {
  return (
    observed.decision.state === 'decided' && observed.decision.value === null
  );
}
