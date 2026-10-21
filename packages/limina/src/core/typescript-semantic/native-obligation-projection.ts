import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { NativeCoverage } from '../../domain/analysis/native-coverage';
import type {
  NativeCompilationObligation,
  ObligationExistence,
} from '../../domain/analysis/native-obligation';
import type { ProjectReferenceRedirect } from '../dependency-semantics';
import { nativeFingerprint } from './native-file-identity';
import type { NativeModuleImpact } from './native-module-impact';

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
  redirect: ProjectReferenceRedirect | undefined,
): string | null {
  if (redirect !== undefined) return redirect.referenceConfig;
  return coverage.state === 'unique' ? coverage.members[0]!.configId : null;
}

export function structure(
  input: ObligationSite,
  configId: string | null,
  redirect: ProjectReferenceRedirect | undefined,
): NativeCompilationObligation['structure'] {
  if (configId === null)
    return { state: 'unknown', reason: 'compilation-unit-endpoint-unproved' };
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
