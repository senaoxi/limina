import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ProjectReferenceRedirect } from '../dependency-semantics';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { NativeObservationError } from './native-observation-failure';
import { observedResolutionHost } from './observed-resolution-host';

interface StructuralProgram extends ts.Program {
  getProjectReferenceRedirect?(file: string): string | undefined;
  getResolvedProjectReferenceToRedirect?(
    file: string,
  ): ts.ResolvedProjectReference | undefined;
  getRedirectFromSourceFile?(file: string):
    | {
        outputDts?: string;
        resolvedRef: ts.ResolvedProjectReference;
      }
    | undefined;
}

/** A project member is not necessarily a declaration redirect (notably JSON
 * and declaration inputs). Unavailable is an audited missing-API stop only;
 * exceptions from an API that exists must reach the execution failure owner. */
export type NativeReferenceObservation =
  | {
      readonly state: 'observed';
      readonly referenceConfig?: string;
      readonly redirect?: ProjectReferenceRedirect;
      readonly javascriptReference: boolean;
      readonly canProveMissingReference: boolean;
    }
  | { readonly state: 'unavailable'; readonly reason: string };

type CompilerReference = ReturnType<
  NonNullable<StructuralProgram['getRedirectFromSourceFile']>
>;

export function observeNativeReference(
  program: ts.Program,
  target: string,
  compiler: typeof ts,
): NativeReferenceObservation {
  if (!hasReferences(program))
    return {
      state: 'observed',
      javascriptReference: false,
      canProveMissingReference: true,
    };
  const raw = readCompilerReference(program, target, compiler);
  return raw === null
    ? { state: 'unavailable', reason: 'reference-map-unavailable' }
    : referenceObservation(raw, target, compiler);
}
function readCompilerReference(
  program: StructuralProgram,
  target: string,
  compiler: typeof ts,
): CompilerReference | null {
  const method = program.getRedirectFromSourceFile;
  if (typeof method === 'function') return method.call(program, target);
  return hasLegacyReferenceApi(program, compiler)
    ? legacyReferenceRedirect(program, target)
    : null;
}

/** The real map can qualify a declaration context when a suppressed directive
 * produced no resolver callback. An unavailable or unqualified negative map
 * must not silently choose the consumer's options. */
export function observeReferenceCompilerOptions(
  program: ts.Program,
  file: string,
  compiler: typeof ts,
): ts.CompilerOptions | undefined {
  if (!hasReferences(program)) return program.getCompilerOptions();
  const reference = readCompilerReference(program, file, compiler);
  return reference === null ||
    (reference === undefined && !isReferenceNegativeQualified(file, compiler))
    ? undefined
    : (reference?.resolvedRef.commandLine.options ??
        program.getCompilerOptions());
}
function referenceObservation(
  raw: CompilerReference,
  target: string,
  compiler: typeof ts,
): NativeReferenceObservation {
  return {
    state: 'observed',
    referenceConfig:
      raw === undefined
        ? undefined
        : normalizeAbsolutePath(raw.resolvedRef.sourceFile.fileName),
    redirect: declarationRedirect(raw, target, compiler),
    javascriptReference:
      raw !== undefined && isJavaScriptReference(target, compiler),
    canProveMissingReference: isReferenceNegativeQualified(target, compiler),
  };
}

function isReferenceNegativeQualified(
  target: string,
  compiler: typeof ts,
): boolean {
  return (
    /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/.test(target) &&
    !isUnmappedDeclaration(target, compiler)
  );
}
function isUnmappedDeclaration(target: string, compiler: typeof ts): boolean {
  // 5.9.0–5.9.2 omit declaration inputs from the source map; 5.9.3 and 6.0
  // records membership without outputDts. A completed lookup is not always
  // qualified to prove that a target's reference is missing.
  return (
    /^5\.9\.[012](?:$|-)/.test(compiler.version) && isDeclarationFile(target)
  );
}
function isJavaScriptReference(target: string, compiler: typeof ts): boolean {
  // Legacy project membership is qualified by the compiler's declaration/JSON
  // exclusion. For supported JS targets this is the same predicate as the
  // modern map; 5.4 has no JS reference exception.
  return [
    !/^5\.4\./.test(compiler.version),
    !/\.(?:d\.[cm]?ts|json)$/.test(target),
  ].every(Boolean);
}

export function observedDeclarationRedirect(
  observation: NativeReferenceObservation | undefined,
): ProjectReferenceRedirect | undefined {
  return observation?.state === 'observed' ? observation.redirect : undefined;
}

/**
Use the compiler's real reference map, never a declaration producer guess.
*/
export function observeProjectReferenceRedirect(
  program: ts.Program,
  target: string,
  tsModule: typeof ts,
): ProjectReferenceRedirect | undefined {
  const observed = observeNativeReference(program, target, tsModule);
  if (observed.state === 'unavailable')
    throw new NativeObservationError('unsupported', observed.reason);
  return observed.redirect;
}

function declarationRedirect(
  redirect: CompilerReference,
  target: string,
  compiler: typeof ts,
): ProjectReferenceRedirect | undefined {
  return redirect === undefined || redirect.outputDts === undefined
    ? undefined
    : concreteRedirect(
        { target, output: redirect.outputDts, reference: redirect.resolvedRef },
        compiler,
      );
}
function concreteRedirect(
  input: {
    target: string;
    output: string;
    reference: ts.ResolvedProjectReference;
  },
  compiler: typeof ts,
): ProjectReferenceRedirect {
  const config = input.reference.sourceFile.fileName;
  return {
    originalTarget: normalizeAbsolutePath(input.target),
    declarationTarget: normalizeAbsolutePath(input.output),
    referenceConfig: normalizeAbsolutePath(config),
    availability: observedResolutionHost(compiler, config).fileExists(
      input.output,
    )
      ? 'present'
      : 'missing',
  };
}

function legacyReferenceRedirect(
  program: StructuralProgram,
  target: string,
): ReturnType<NonNullable<StructuralProgram['getRedirectFromSourceFile']>> {
  const outputDts = program.getProjectReferenceRedirect!(target);
  const resolvedReference =
    program.getResolvedProjectReferenceToRedirect!(target);
  assertReferenceContext(outputDts, resolvedReference);
  return resolvedReference === undefined
    ? undefined
    : { outputDts, resolvedRef: resolvedReference };
}

function assertReferenceContext(
  output: string | undefined,
  reference: ts.ResolvedProjectReference | undefined,
): void {
  if (reference === undefined && output !== undefined)
    throw new NativeObservationError(
      'internal',
      'Compiler redirect has no reference context.',
    );
}

function hasLegacyReferenceApi(
  program: StructuralProgram,
  compiler: typeof ts,
): boolean {
  return (
    /^5\.[4-8]\./.test(compiler.version) &&
    [
      program.getProjectReferenceRedirect,
      program.getResolvedProjectReferenceToRedirect,
    ].every((method) => typeof method === 'function')
  );
}
function hasReferences(program: ts.Program): boolean {
  return (program.getProjectReferences()?.length ?? 0) > 0;
}
