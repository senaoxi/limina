import type ts from 'typescript';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import {
  nativeCompilerApi,
  type NativeObservedProgram,
} from './native-program-api';
import type { NativeModuleObservation } from './native-program-requests';
import type { NativeReferenceObservation } from './reference-redirect';

export type NativeModuleImpact =
  | { readonly state: 'absent' | 'present'; readonly rule: string }
  | { readonly state: 'unknown'; readonly reason: string };

interface ImpactInput {
  observation: NativeModuleObservation;
  program: NativeObservedProgram;
  compiler: typeof ts;
  reference: NativeReferenceObservation | undefined;
}
type RequestInput = Pick<ImpactInput, 'observation' | 'program'>;
interface TargetInput {
  target: string;
  compiler: typeof ts;
  inputOptions: ts.CompilerOptions;
  emitOptions: ts.CompilerOptions;
  reference: NativeReferenceObservation | undefined;
}

/** These proofs apply to this occurrence, including unresolved requests. They
 * do not depend on declaration mapping or cancel another request's obligation. */
export function independentModuleAbsence(
  input: RequestInput,
): NativeModuleImpact | undefined {
  return input.observation.role === 'augmentation'
    ? { state: 'absent', rule: 'compiler-augmentation-does-not-add-input' }
    : (rootAbsence(input) ?? noResolveAbsence(input));
}
function noResolveAbsence(input: RequestInput): NativeModuleImpact | undefined {
  const options = input.program.getCompilerOptionsForFile(
    input.observation.source,
  );
  return options?.noResolve
    ? { state: 'absent', rule: 'compiler-noResolve-disables-module-input' }
    : undefined;
}
function rootAbsence(input: RequestInput): NativeModuleImpact | undefined {
  const target = moduleTarget(input.observation);
  if (target === undefined) return undefined;
  return input.program.getRootFileNames().includes(target)
    ? { state: 'absent', rule: 'consumer-root-has-no-cross-unit-obligation' }
    : undefined;
}
function moduleTarget(
  observation: NativeModuleObservation,
): string | undefined {
  return observation.raw?.resolvedModule?.resolvedFileName;
}

/** Sufficient input and emit premises for the existing fixed-root declaration
 * project contract. Selection, diagnostics, JSDoc and roles stay at the entry. */
export function observeNativeModuleImpact(
  input: ImpactInput,
): NativeModuleImpact {
  const target = input.observation.raw?.resolvedModule;
  return target === undefined
    ? {
        state: 'unknown',
        reason: 'compiler-resolution-observation-unavailable',
      }
    : classifyTarget(input, target);
}
function classifyTarget(
  input: ImpactInput,
  target: ts.ResolvedModuleFull,
): NativeModuleImpact {
  if (isDeclarationFile(target.resolvedFileName))
    return {
      state: 'absent',
      rule: 'declaration-consumption-does-not-establish-a-producer',
    };
  return target.extension === input.compiler.Extension.Json
    ? {
        state: 'unknown',
        reason: 'json-emission-requires-output-projection-proof',
      }
    : classifyImplementation(input, target);
}
function isExternalInput(
  input: ImpactInput,
  target: ts.ResolvedModuleFull,
): boolean {
  return (
    target.isExternalLibraryImport === true ||
    input.program.isSourceFileFromExternalLibrary(input.observation.source)
  );
}
function classifyImplementation(
  input: ImpactInput,
  target: ts.ResolvedModuleFull,
): NativeModuleImpact {
  if (isExternalInput(input, target))
    return {
      state: 'absent',
      rule: 'compiler-external-library-input-is-not-emitted-by-consumer',
    };
  const options = input.program.getCompilerOptionsForFile(
    input.observation.source,
  );
  return options === undefined
    ? { state: 'unknown', reason: 'compiler-source-options-unavailable' }
    : diagnosticImpact(input, target, options);
}
function diagnosticImpact(
  input: ImpactInput,
  target: ts.ResolvedModuleFull,
  options: ts.CompilerOptions,
): NativeModuleImpact {
  const diagnostic = nativeCompilerApi(input.compiler).getResolutionDiagnostic(
    options,
    target,
    input.observation.source,
  );
  return diagnostic === undefined
    ? inputEligibility(input, target, options)
    : {
        state: 'absent',
        rule: `compiler-resolution-diagnostic:${diagnostic.code}`,
      };
}
function inputEligibility(
  input: ImpactInput,
  target: ts.ResolvedModuleFull,
  options: ts.CompilerOptions,
): NativeModuleImpact {
  return isExcludedDocumentation(input)
    ? { state: 'absent', rule: 'compiler-typescript-jsdoc-input-excluded' }
    : moduleTargetEligibility({
        target: target.resolvedFileName,
        compiler: input.compiler,
        inputOptions: options,
        emitOptions: input.program.getCompilerOptions(),
        reference: input.reference,
      });
}
function isExcludedDocumentation(input: ImpactInput): boolean {
  const isDocumentation = (input.observation.literal.flags & 16_777_216) !== 0;
  return (
    isDocumentation &&
    !nativeCompilerApi(input.compiler).isInJSFile(input.observation.literal)
  );
}

function moduleTargetEligibility(input: TargetInput): NativeModuleImpact {
  return /\.(?:js|jsx|mjs|cjs)$/.test(input.target)
    ? javaScriptEligibility(input)
    : nativeTargetEligibility(input);
}

/** Selection and JS input permission belong to each request entry. Only
 * recognized target classification and consumer emit eligibility are shared. */
export function nativeTargetEligibility(
  input: Pick<TargetInput, 'target' | 'compiler' | 'emitOptions'>,
): NativeModuleImpact {
  if (/\.(?:js|jsx|mjs|cjs)$/.test(input.target))
    return javaScriptEmitEligibility(input);
  return /\.(?:ts|tsx|mts|cts)$/.test(input.target)
    ? eligibleTarget(input)
    : {
        state: 'unknown',
        reason: 'target-emission-rule-unqualified-for-extension',
      };
}
function javaScriptEmitEligibility(
  input: Pick<TargetInput, 'compiler' | 'emitOptions'>,
): NativeModuleImpact {
  return input.emitOptions.noEmitForJsFiles
    ? { state: 'absent', rule: 'compiler-javascript-emission-disabled' }
    : eligibleTarget(input);
}
function javaScriptEligibility(input: TargetInput): NativeModuleImpact {
  const reference = input.reference;
  return reference?.state === 'observed'
    ? referenceJavaScriptEligibility(input, reference)
    : unmappedJavaScriptEligibility(input);
}
function referenceJavaScriptEligibility(
  input: TargetInput,
  reference: Extract<NativeReferenceObservation, { state: 'observed' }>,
): NativeModuleImpact {
  // processImportedModules changed in 5.5; retain the version's membership
  // predicate independently of the optional declaration output path.
  return reference.javascriptReference
    ? eligibleTarget(input)
    : ordinaryJavaScriptEligibility(input);
}
function unmappedJavaScriptEligibility(input: TargetInput): NativeModuleImpact {
  const ordinary = ordinaryJavaScriptEligibility(input);
  // If both mapping alternatives permit input/emit, the map gap affects only
  // structure. A negative JS rule still needs the version's reference premise.
  return ordinary.state === 'present'
    ? ordinary
    : {
        state: 'unknown',
        reason: 'javascript-reference-qualification-unavailable',
      };
}
function ordinaryJavaScriptEligibility(input: TargetInput): NativeModuleImpact {
  return nativeCompilerApi(input.compiler).getAllowJSCompilerOption(
    input.inputOptions,
  )
    ? nativeTargetEligibility(input)
    : { state: 'absent', rule: 'compiler-javascript-input-disabled' };
}
function eligibleTarget(
  input: Pick<TargetInput, 'compiler'>,
): NativeModuleImpact {
  return {
    state: 'present',
    rule: `declaration-project-composite-root-membership:typescript-${input.compiler.version}`,
  };
}
