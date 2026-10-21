import type ts from 'typescript';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import {
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
import { NativeObservationError } from './native-observation-failure';
import {
  type NativeObservedProgram,
  nativeProgramSource,
} from './native-program-api';
import type { NativeProgramFrontier } from './native-program-frontier';
import type { NativeModuleObservation } from './native-program-requests';
import { observeProjectReferenceRedirect } from './reference-redirect';

interface ObligationInput {
  sourceLoadGap?: string;
  compiler: typeof ts;
  context: NativeEvidenceContext;
  frontier: NativeProgramFrontier;
  program: NativeObservedProgram;
  observation: NativeModuleObservation;
}

function observedImpact(
  input: ObligationInput,
  target: string,
): NativeModuleImpact {
  return input.program.getRootFileNames().includes(target)
    ? { state: 'absent', rule: 'consumer-root-has-no-cross-unit-obligation' }
    : scopedImpact(input, observeNativeModuleImpact(input));
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
  try {
    return observedObligation(input);
  } catch (error) {
    if (!isUnsupportedObservation(error)) throw error;
    return unavailableObligation(input, 'reference-map-unavailable');
  }
}
function isUnsupportedObservation(error: unknown): boolean {
  return (
    error instanceof NativeObservationError && error.kind === 'unsupported'
  );
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
  const impact: NativeModuleImpact = isAmbient
    ? { state: 'absent', rule: 'compiler-local-ambient-module' }
    : missingModuleImpact(input.observation);
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
  const redirect = observeProjectReferenceRedirect(
    input.program,
    target,
    input.compiler,
  );
  const configId = targetConfig(coverage, redirect);
  return {
    ...obligationIdentity(site(input)),
    targetConfigId: configId,
    existence: existence(site(input), observedImpact(input, target)),
    structure: structure(site(input), configId, redirect),
    artifact: artifact(redirect),
  };
}

function site(input: ObligationInput) {
  return { context: input.context, requestId: input.observation.requestId };
}

function unavailableObligation(
  input: ObligationInput,
  reason: string,
): NativeCompilationObligation {
  return {
    ...obligationIdentity(site(input)),
    targetConfigId: null,
    existence: {
      state: 'unknown',
      gapIds: [input.observation.requestId, reason],
    },
    structure: { state: 'unknown', reason },
    artifact: { state: 'unknown', reason },
  };
}
