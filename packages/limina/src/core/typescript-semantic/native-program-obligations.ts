import type ts from 'typescript';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import {
  independentModuleAbsence,
  type NativeModuleImpact,
  observeNativeModuleImpact,
} from './native-module-impact';
import {
  artifact,
  existence,
  obligationIdentity,
  structure,
  targetConfig,
} from './native-obligation-projection';
import {
  type NativeObservedProgram,
  nativeProgramSource,
} from './native-program-api';
import type { NativeProgramFrontier } from './native-program-frontier';
import type { NativeModuleObservation } from './native-program-requests';
import type { NativeReferenceObservation } from './reference-redirect';

interface ObligationInput {
  sourceLoadGap?: string;
  compiler: typeof ts;
  context: NativeEvidenceContext;
  frontier: NativeProgramFrontier;
  program: NativeObservedProgram;
  observation: NativeModuleObservation;
  references: ReadonlyMap<string, NativeReferenceObservation>;
}

function observedImpact(
  input: ObligationInput,
  target: string,
): NativeModuleImpact {
  return (
    independentModuleAbsence(input) ??
    scopedImpact(
      input,
      observeNativeModuleImpact({
        ...input,
        reference: input.references.get(target),
      }),
    )
  );
}

function scopedImpact(
  input: ObligationInput,
  impact: NativeModuleImpact,
): NativeModuleImpact {
  return impact.state === 'present'
    ? qualifiedSourceImpact(input, impact)
    : impact;
}
function qualifiedSourceImpact(
  input: ObligationInput,
  impact: NativeModuleImpact,
): NativeModuleImpact {
  if (input.sourceLoadGap !== undefined)
    return { state: 'unknown', reason: input.sourceLoadGap };
  return hasCompositeScope(input)
    ? impact
    : {
        state: 'unknown',
        reason: 'fixed-root-composite-compilation-scope-not-established',
      };
}

function hasCompositeScope(input: ObligationInput): boolean {
  return (
    input.program.getCompilerOptions().composite === true ||
    input.context.inputs.compilationScope === 'generated-declaration-project-v1'
  );
}

export function createNativeModuleObligation(
  input: ObligationInput,
): NativeCompilationObligation {
  return observedObligation(input);
}
function observedObligation(
  input: ObligationInput,
): NativeCompilationObligation {
  const target = moduleTarget(input.observation);
  return target === undefined
    ? unresolvedObligation(input)
    : resolvedObligation(input, target);
}

function unresolvedObligation(
  input: ObligationInput,
): NativeCompilationObligation {
  const isAmbient = nativeProgramSource(
    input.observation.source,
  ).ambientModuleNames.includes(input.observation.literal.text);
  const impact: NativeModuleImpact =
    independentModuleAbsence(input) ??
    (isAmbient
      ? { state: 'absent', rule: 'compiler-local-ambient-module' }
      : missingModuleImpact(input.observation));
  return {
    ...obligationIdentity(site(input)),
    targetConfigId: null,
    existence: existence(site(input), impact),
    structure: { state: 'unknown', reason: 'no-proven-target' },
    artifact: { state: 'unknown', reason: 'no-proven-producer' },
  };
}

function missingModuleImpact(
  observation: NativeModuleObservation,
): NativeModuleImpact {
  return observation.raw === undefined
    ? {
        state: 'unknown',
        reason: 'compiler-resolution-observation-unavailable',
      }
    : {
        state: 'absent',
        rule: 'compiler-completed-resolution-without-file-input',
      };
}

function moduleTarget(
  observation: NativeModuleObservation,
): string | undefined {
  return observation.raw?.resolvedModule?.resolvedFileName;
}

function resolvedObligation(
  input: ObligationInput,
  target: string,
): NativeCompilationObligation {
  const { coverage } = input.frontier.inspect(target);
  const reference = input.references.get(target);
  const redirect =
    reference?.state === 'observed' ? reference.redirect : undefined;
  const configId = targetConfig(coverage, reference);
  return {
    ...obligationIdentity(site(input)),
    targetConfigId: configId,
    existence: existence(site(input), observedImpact(input, target)),
    structure: structure(site(input), configId, reference),
    artifact: artifact(redirect),
  };
}

function site(input: ObligationInput) {
  return { context: input.context, requestId: input.observation.requestId };
}
