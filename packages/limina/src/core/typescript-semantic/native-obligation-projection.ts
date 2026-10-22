import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { NativeCoverage } from '../../domain/analysis/native-coverage';
import type {
  NativeCompilationObligation,
  ObligationExistence,
} from '../../domain/analysis/native-obligation';
import type { ProjectReferenceRedirect } from '../dependency-semantics';
import { nativeFingerprint } from './native-file-identity';
import type { NativeModuleImpact } from './native-module-impact';
import {
  type NativeReferenceObservation,
  observedDeclarationRedirect,
} from './reference-redirect';

export interface ObligationSite {
  context: NativeEvidenceContext;
  requestId: string;
}

export function existence(
  input: ObligationSite,
  impact: NativeModuleImpact,
): ObligationExistence {
  return impact.state === 'unknown'
    ? { state: 'unknown', gapIds: [impact.reason] }
    : {
        state: impact.state,
        proof: {
          kind: 'audited-rule',
          evidenceId: input.requestId,
          contextId: input.context.id,
          ruleOrObservation: impact.rule,
        },
      };
}

export function targetConfig(
  coverage: NativeCoverage,
  observation: NativeReferenceObservation | undefined,
): string | null {
  const reference = observedReferenceConfig(observation);
  return reference ?? coveredConfig(coverage);
}
function observedReferenceConfig(
  observation: NativeReferenceObservation | undefined,
): string | undefined {
  return observation?.state === 'observed'
    ? observation.referenceConfig
    : undefined;
}
function coveredConfig(coverage: NativeCoverage): string | null {
  return coverage.state === 'unique' ? coverage.members[0]!.configId : null;
}

export function structure(
  input: ObligationSite,
  configId: string | null,
  observation: NativeReferenceObservation | undefined,
): NativeCompilationObligation['structure'] {
  const reason = structureGap(input, configId, observation);
  return reason === undefined
    ? provenStructure(
        input,
        configId!,
        observedDeclarationRedirect(observation),
      )
    : { state: 'unknown', reason };
}
function structureGap(
  input: ObligationSite,
  configId: string | null,
  observation: NativeReferenceObservation | undefined,
): string | undefined {
  if (configId === null) return 'compilation-unit-endpoint-unproved';
  // Empty effective references are independent negative structure evidence.
  return input.context.inputs.rawReferences === nativeFingerprint([])
    ? undefined
    : observedStructureGap(observation);
}
function observedStructureGap(
  observation: NativeReferenceObservation | undefined,
): string | undefined {
  if (observation === undefined) return 'reference-map-not-observed';
  return observation.state === 'unavailable'
    ? observation.reason
    : qualifiedStructureGap(observation);
}
function qualifiedStructureGap(
  observation: Extract<NativeReferenceObservation, { state: 'observed' }>,
): string | undefined {
  return membershipGap(observation) ?? negativeReferenceGap(observation);
}
function negativeReferenceGap(
  observation: Extract<NativeReferenceObservation, { state: 'observed' }>,
): string | undefined {
  return observation.redirect === undefined &&
    !observation.canProveMissingReference
    ? 'reference-map-negative-unqualified-for-target'
    : undefined;
}
function membershipGap(
  observation: Extract<NativeReferenceObservation, { state: 'observed' }>,
): string | undefined {
  return observation.referenceConfig !== undefined &&
    observation.redirect === undefined
    ? 'reference-membership-without-declaration-mapping'
    : undefined;
}
function provenStructure(
  input: ObligationSite,
  configId: string,
  redirect: ProjectReferenceRedirect | undefined,
): NativeCompilationObligation['structure'] {
  return {
    state: redirect === undefined ? 'unsatisfied' : 'satisfied',
    evidenceId: nativeFingerprint([input.requestId, redirect]),
    contextId: input.context.id,
    rawReferenceFingerprint: input.context.inputs.rawReferences,
    mapping: {
      consumerConfigId: input.context.inputs.config,
      targetConfigId: configId,
      redirectEvidenceIds: redirectEvidence(redirect),
    },
  };
}

export function redirectEvidence(
  redirect: ProjectReferenceRedirect | undefined,
): string[] {
  return redirect === undefined ? [] : [nativeFingerprint(redirect)];
}

export function artifact(
  redirect: ProjectReferenceRedirect | undefined,
): NativeCompilationObligation['artifact'] {
  if (redirect === undefined)
    return {
      state: 'unknown',
      reason: 'provider-output-mapping-not-yet-projected',
    };
  return redirect.availability === 'missing'
    ? { state: 'missing', evidenceId: nativeFingerprint(redirect) }
    : {
        state: 'unknown',
        reason:
          'file-existence-does-not-prove-output-freshness-or-compatibility',
      };
}

export function obligationIdentity(
  input: ObligationSite,
): Pick<
  NativeCompilationObligation,
  | 'id'
  | 'requestIds'
  | 'consumerContextId'
  | 'consumerConfigId'
  | 'rawReferenceFingerprint'
> {
  return {
    id: nativeFingerprint(['compilation-obligation', input.requestId]),
    requestIds: [input.requestId],
    consumerContextId: input.context.id,
    consumerConfigId: input.context.inputs.config,
    rawReferenceFingerprint: input.context.inputs.rawReferences,
  };
}
