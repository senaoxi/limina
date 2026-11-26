import type ts from 'typescript';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { compilerFileKey } from './compiler-coverage';
import { nativeCompilerApi } from './native-program-api';
import type { NativeReferenceObservation } from './reference-redirect';

export type NativeModuleImpact =
  | { readonly state: 'absent' | 'present'; readonly rule: string }
  | { readonly state: 'unknown'; readonly reason: string };

interface ModuleInput {
  role: 'import' | 'augmentation';
  options: ts.CompilerOptions | undefined;
  target: string | undefined;
}
interface TargetInput {
  service?: { extension: string; scriptKind: ts.ScriptKind };
  target: string;
  extension: ts.ResolvedModuleFull['extension'];
  compiler: typeof ts;
  inputOptions: ts.CompilerOptions;
  emitOptions: ts.CompilerOptions;
  reference: NativeReferenceObservation | undefined;
}

export function independentModuleInputAbsence(
  input: ModuleInput & {
    roots: readonly string[];
    fileKey?: (file: string) => string;
  },
): NativeModuleImpact | undefined {
  const fileKey = input.fileKey ?? compilerFileKey;
  return independentModuleInputAbsenceForRoot(input, (target) => {
    const targetKey = fileKey(target);
    return input.roots.some((root) => fileKey(root) === targetKey);
  });
}

/** These proofs apply to this occurrence, including unresolved requests. They
 * do not depend on declaration mapping or cancel another request's obligation. */
export function independentModuleInputAbsenceForRoot(
  input: ModuleInput,
  isConsumerRoot: (file: string) => boolean,
): NativeModuleImpact | undefined {
  if (input.role === 'augmentation')
    return {
      state: 'absent',
      rule: 'compiler-augmentation-does-not-add-input',
    };
  if (input.target !== undefined && isConsumerRoot(input.target))
    return {
      state: 'absent',
      rule: 'consumer-root-has-no-cross-unit-obligation',
    };
  return input.options?.noResolve
    ? { state: 'absent', rule: 'compiler-noResolve-disables-module-input' }
    : undefined;
}
/** Shared premises for native observations and separately qualified adapters.
 * A service classification describes an actual generated script, never a
 * replacement filename or a manufactured compiler resolution. */
export interface ModuleImpactPremises {
  target: ts.ResolvedModuleFull;
  compiler: typeof ts;
  inputOptions: ts.CompilerOptions | undefined;
  emitOptions: ts.CompilerOptions;
  reference: NativeReferenceObservation | undefined;
  sourceIsExternal: boolean;
  sourceIsDeclaration: boolean;
  excludedDocumentation: boolean;
  service?: { extension: string; scriptKind: ts.ScriptKind };
}
export function evaluateModuleImpact(
  input: ModuleImpactPremises,
): NativeModuleImpact {
  const { target, compiler } = input;
  if (isDeclarationFile(target.resolvedFileName))
    return {
      state: 'absent',
      rule: 'declaration-consumption-does-not-establish-a-producer',
    };
  if (target.extension === compiler.Extension.Json)
    return {
      state: 'unknown',
      reason: 'json-emission-requires-output-projection-proof',
    };
  if (target.isExternalLibraryImport || input.sourceIsExternal)
    return {
      state: 'absent',
      rule: 'compiler-external-library-input-is-not-emitted-by-consumer',
    };
  if (input.inputOptions === undefined)
    return { state: 'unknown', reason: 'compiler-source-options-unavailable' };
  const diagnostic = nativeCompilerApi(compiler).getResolutionDiagnostic(
    input.inputOptions,
    target,
    { isDeclarationFile: input.sourceIsDeclaration },
  );
  if (diagnostic !== undefined)
    return {
      state: 'absent',
      rule: `compiler-resolution-diagnostic:${diagnostic.code}`,
    };
  if (input.excludedDocumentation)
    return {
      state: 'absent',
      rule: 'compiler-typescript-jsdoc-input-excluded',
    };
  return moduleTargetEligibility({
    target: target.resolvedFileName,
    extension: target.extension,
    compiler,
    inputOptions: input.inputOptions,
    emitOptions: input.emitOptions,
    reference: input.reference,
    service: input.service,
  });
}

function moduleTargetEligibility(input: TargetInput): NativeModuleImpact {
  return nativeCompilerApi(input.compiler).resolutionExtensionIsTSOrJson(
    input.extension,
  )
    ? nativeTargetEligibility(input)
    : javaScriptEligibility(input);
}

/** Selection and JS input permission belong to each request entry. Only
 * recognized target classification and consumer emit eligibility are shared. */
export function nativeTargetEligibility(
  input: Pick<TargetInput, 'target' | 'compiler' | 'emitOptions' | 'service'>,
): NativeModuleImpact {
  if (/\.(?:js|jsx|mjs|cjs)$/.test(input.target))
    return javaScriptEmitEligibility(input);
  if (input.service !== undefined && isQualifiedService(input)) {
    return [
      input.compiler.ScriptKind.JS,
      input.compiler.ScriptKind.JSX,
    ].includes(input.service.scriptKind)
      ? javaScriptEmitEligibility(input)
      : eligibleTarget(input);
  }
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
  if (
    !/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(input.target) &&
    (input.service === undefined || !isQualifiedService(input))
  )
    return {
      state: 'unknown',
      reason: 'target-emission-rule-unqualified-for-extension',
    };
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
    ? input.emitOptions.noEmitForJsFiles
      ? { state: 'absent', rule: 'compiler-javascript-emission-disabled' }
      : nativeTargetEligibility(input)
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

function isQualifiedService(
  input: Pick<TargetInput, 'compiler' | 'service'>,
): boolean {
  const { Extension, ScriptKind } = input.compiler;
  return (
    new Map<string, ts.ScriptKind>([
      [Extension.Ts, ScriptKind.TS],
      [Extension.Tsx, ScriptKind.TSX],
      [Extension.Js, ScriptKind.JS],
      [Extension.Jsx, ScriptKind.JSX],
    ]).get(input.service!.extension) === input.service!.scriptKind
  );
}
