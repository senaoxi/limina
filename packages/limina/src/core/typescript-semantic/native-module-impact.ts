import type ts from 'typescript';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import {
  nativeCompilerApi,
  type NativeObservedProgram,
} from './native-program-api';
import type { NativeModuleObservation } from './native-program-requests';
import { compilerReferenceRedirect } from './reference-redirect';

export type NativeModuleImpact =
  | { readonly state: 'absent' | 'present'; readonly rule: string }
  | { readonly state: 'unknown'; readonly reason: string };

interface ImpactInput {
  observation: NativeModuleObservation;
  program: NativeObservedProgram;
  compiler: typeof ts;
}

/**
 * A sufficient rule for the existing declaration-project projection (fixed
 * roots, composite, declaration emit). It does not assert that ordinary tsc
 * always requires a project reference. Roots and raw options are not changed.
 *
 * TypeScript 5.4–5.9 / 6.0 processImportedModules and sourceFileMayBeEmitted are the
 * audited premises. JSON and suppressed/augmentation requests remain unknown;
 * loading or ownership alone is never a proof.
 */
export function observeNativeModuleImpact(
  input: ImpactInput,
): NativeModuleImpact {
  const target = input.observation.raw?.resolvedModule;
  return target === undefined
    ? { state: 'absent', rule: 'compiler-resolution-without-file-target' }
    : resolvedModuleImpact(input, target);
}

function resolvedModuleImpact(
  input: ImpactInput,
  target: ts.ResolvedModuleFull,
): NativeModuleImpact {
  if (input.observation.role === 'augmentation')
    return {
      state: 'unknown',
      reason: 'augmentation-is-not-an-input-membership-proof',
    };
  return input.program.getCompilerOptionsForFile(input.observation.source)
    .noResolve
    ? {
        state: 'unknown',
        reason: 'noResolve-has-no-audited-compilation-obligation-rule',
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
  const diagnostic = nativeCompilerApi(input.compiler).getResolutionDiagnostic(
    input.program.getCompilerOptionsForFile(input.observation.source),
    target,
    input.observation.source,
  );
  return diagnostic === undefined
    ? classifyInputEligibility(input, target)
    : {
        state: 'absent',
        rule: `compiler-resolution-diagnostic:${diagnostic.code}`,
      };
}

function classifyInputEligibility(
  input: ImpactInput,
  target: ts.ResolvedModuleFull,
): NativeModuleImpact {
  const api = nativeCompilerApi(input.compiler);
  const isJavaScript = !api.resolutionExtensionIsTSOrJson(target.extension);
  return isJavaScript && !isRedirectedJavaScriptInput(input, target)
    ? javaScriptImpact(input)
    : typeScriptImpact(input);
}

function isRedirectedJavaScriptInput(
  input: ImpactInput,
  target: ts.ResolvedModuleFull,
) {
  return (
    !/^5\.[4-8]\./.test(input.compiler.version) &&
    compilerReferenceRedirect(
      input.program,
      target.resolvedFileName,
      input.compiler,
    ) !== undefined
  );
}

function javaScriptImpact(input: ImpactInput): NativeModuleImpact {
  const options = input.program.getCompilerOptionsForFile(
    input.observation.source,
  );
  if (!nativeCompilerApi(input.compiler).getAllowJSCompilerOption(options))
    return { state: 'absent', rule: 'compiler-javascript-input-disabled' };
  return options.noEmitForJsFiles
    ? { state: 'absent', rule: 'compiler-javascript-emission-disabled' }
    : typeScriptImpact(input);
}

function typeScriptImpact(input: ImpactInput): NativeModuleImpact {
  // TypeScript's request inventory may include JSDoc imports without loading
  // them. NodeFlags.JSDoc is internal to this version-bound adapter.
  const isDocumentation = (input.observation.literal.flags & 16_777_216) !== 0;
  const isJavaScript = nativeCompilerApi(input.compiler).isInJSFile(
    input.observation.literal,
  );
  return isDocumentation && !isJavaScript
    ? { state: 'absent', rule: 'compiler-typescript-jsdoc-input-excluded' }
    : {
        state: 'present',
        rule: `declaration-project-composite-root-membership:typescript-${input.compiler.version}`,
      };
}
