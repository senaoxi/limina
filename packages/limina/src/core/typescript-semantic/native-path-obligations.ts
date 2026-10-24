import type ts from 'typescript';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { hasCompilerRoot } from './compiler-membership';
import {
  type NativeModuleImpact,
  nativeTargetEligibility,
} from './native-module-impact';
import {
  artifact,
  existence,
  obligationIdentity,
  type ObligationSite,
  structure,
  targetConfig,
} from './native-obligation-projection';
import type { NativePathReceipt } from './native-path-selection';
import type { NativeObservedProgram } from './native-program-api';
import type { NativeProgramFrontier } from './native-program-frontier';
import type { NativeReferenceObservation } from './reference-redirect';

interface PathObligationInput extends ObligationSite {
  source?: ts.SourceFile;
  sourceLoadGap?: string;
  receipt: NativePathReceipt;
  program: NativeObservedProgram;
  frontier: NativeProgramFrontier;
  compiler: typeof ts;
  references: ReadonlyMap<string, NativeReferenceObservation>;
}

/** A path occurrence supplies an input-membership proof directly. No synthetic
 * import or changed compiler roots are needed for composite declaration scope. */
export function createNativePathObligation(
  input: PathObligationInput,
): NativeCompilationObligation {
  const logical = input.receipt.selection.logicalTarget;
  const configId = pathTargetConfig(input, logical);
  const impact = pathImpact(input);
  const notApplicable = {
    state: 'not-applicable' as const,
    reason: 'no-compilation-obligation',
  };
  return {
    ...obligationIdentity(input),
    targetConfigId: configId,
    existence: existence(input, impact),
    structure:
      impact.state === 'absent'
        ? notApplicable
        : structure(input, configId, pathReference(input)),
    artifact:
      impact.state === 'absent'
        ? notApplicable
        : artifact(input.receipt.redirect),
  };
}

function pathImpact(input: PathObligationInput): NativeModuleImpact {
  const selection = input.receipt.selection;
  if (selection.state === 'unavailable')
    return {
      state: 'unknown',
      reason: pathUnavailableReason(input),
    };
  return selection.state === 'disabled'
    ? { state: 'absent', rule: 'compiler-noResolve-disables-path-input' }
    : selectedPathImpact(input);
}

function selectedPathImpact(input: PathObligationInput): NativeModuleImpact {
  const target = input.receipt.selection.logicalTarget;
  if (target === null)
    return { state: 'absent', rule: 'compiler-path-candidates-exhausted' };
  if (isDeclarationFile(target))
    return {
      state: 'absent',
      rule: 'declaration-consumption-does-not-establish-a-producer',
    };
  return rootOrImplementationImpact(input, target);
}
function rootOrImplementationImpact(
  input: PathObligationInput,
  target: string,
): NativeModuleImpact {
  if (hasCompilerRoot(input.program, target))
    return {
      state: 'absent',
      rule: 'consumer-root-has-no-cross-unit-obligation',
    };
  return sourceImpact(input, target);
}

function implementationImpact(
  input: PathObligationInput,
  target: string,
): NativeModuleImpact {
  const qualification = pathTargetEligibility(input, target);
  if (qualification.state !== 'present') return qualification;
  const isScoped = [
    input.program.getCompilerOptions().composite === true,
    input.context.inputs.compilationScope ===
      'generated-declaration-project-v1',
  ].some(Boolean);
  return isScoped
    ? {
        state: 'present',
        rule: 'typescript-path-input-composite-root-membership-v1',
      }
    : {
        state: 'unknown',
        reason: 'fixed-root-composite-compilation-scope-not-established',
      };
}

function pathTargetConfig(
  input: PathObligationInput,
  logical: string | null,
): string | null {
  return logical === null
    ? null
    : targetConfig(
        input.frontier.inspect(logical).coverage,
        input.references.get(logical),
      );
}

function pathUnavailableReason(input: PathObligationInput): string {
  return input.receipt.selection.reason ?? 'path-selection-unavailable';
}

function sourceImpact(
  input: PathObligationInput,
  target: string,
): NativeModuleImpact {
  if (input.sourceLoadGap !== undefined)
    return { state: 'unknown', reason: input.sourceLoadGap };
  return hasExternalSource(input)
    ? {
        state: 'absent',
        rule: 'compiler-external-library-path-input-is-not-emitted-by-consumer',
      }
    : implementationImpact(input, target);
}
function hasExternalSource(input: PathObligationInput): boolean {
  return (
    input.source !== undefined &&
    input.program.isSourceFileFromExternalLibrary(input.source)
  );
}

function pathReference(
  input: PathObligationInput,
): NativeReferenceObservation | undefined {
  const target = input.receipt.selection.logicalTarget;
  return target === null ? undefined : input.references.get(target);
}

function pathTargetEligibility(
  input: PathObligationInput,
  target: string,
): NativeModuleImpact {
  const qualification = nativeTargetEligibility({
    target,
    compiler: input.compiler,
    emitOptions: input.program.getCompilerOptions(),
  });
  return qualification.state === 'absent'
    ? redirectedPathEmission(input, qualification)
    : qualification;
}
function redirectedPathEmission(
  input: PathObligationInput,
  qualification: NativeModuleImpact,
): NativeModuleImpact {
  // A selected declaration mapping is not a JS SourceFile emitted by this
  // consumer. Its noEmitForJsFiles cannot negate the provider's obligation.
  return input.receipt.redirect === undefined
    ? qualification
    : {
        state: 'unknown',
        reason: 'redirected-path-javascript-emission-unproved',
      };
}
