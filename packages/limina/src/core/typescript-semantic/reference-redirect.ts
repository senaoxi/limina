import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ProjectReferenceRedirect } from '../dependency-semantics';
import { NativeObservationError } from './native-observation-failure';
import { observedResolutionHost } from './observed-resolution-host';

interface StructuralProgram extends ts.Program {
  getProjectReferenceRedirect?(file: string): string | undefined;
  getResolvedProjectReferenceToRedirect?(
    file: string,
  ): ts.ResolvedProjectReference | undefined;
  getRedirectFromSourceFile?(file: string):
    | {
        outputDts: string;
        resolvedRef: ts.ResolvedProjectReference;
      }
    | undefined;
}

/**
Use the compiler's real reference map, never a declaration producer guess.
*/
export function observeProjectReferenceRedirect(
  program: ts.Program,
  target: string,
  tsModule: typeof ts,
): ProjectReferenceRedirect | undefined {
  const redirect = compilerReferenceRedirect(program, target, tsModule);
  if (redirect === undefined) return undefined;
  return {
    originalTarget: normalizeAbsolutePath(target),
    declarationTarget: normalizeAbsolutePath(redirect.outputDts),
    referenceConfig: normalizeAbsolutePath(
      redirect.resolvedRef.sourceFile.fileName,
    ),
    availability: observedResolutionHost(
      tsModule,
      redirect.resolvedRef.sourceFile.fileName,
    ).fileExists(redirect.outputDts)
      ? 'present'
      : 'missing',
  };
}

export function compilerReferenceRedirect(
  program: ts.Program,
  target: string,
  compiler: typeof ts,
): ReturnType<NonNullable<StructuralProgram['getRedirectFromSourceFile']>> {
  const method = (program as StructuralProgram).getRedirectFromSourceFile;
  if (method !== undefined) return method.call(program, target);
  return /^5\.[4-8]\./.test(compiler.version)
    ? legacyReferenceRedirect(program as StructuralProgram, target)
    : unsupportedReferenceRedirect(program, target, compiler);
}

function unsupportedReferenceRedirect(
  program: ts.Program,
  target: string,
  compiler: typeof ts,
): undefined {
  if (hasReferences(program))
    throw new NativeObservationError(
      'unsupported',
      `Project reference redirect observation is unsupported by TypeScript ${compiler.version}: ${target}`,
    );
}

function legacyReferenceRedirect(
  program: StructuralProgram,
  target: string,
): ReturnType<NonNullable<StructuralProgram['getRedirectFromSourceFile']>> {
  assertLegacyReferenceApi(program);
  const outputDts = program.getProjectReferenceRedirect!(target);
  if (outputDts === undefined) return outputDts;
  const resolvedReference =
    program.getResolvedProjectReferenceToRedirect!(target);
  if (resolvedReference === undefined)
    throw new NativeObservationError(
      'internal',
      'Compiler redirect has no reference context.',
    );
  return { outputDts, resolvedRef: resolvedReference };
}

function assertLegacyReferenceApi(program: StructuralProgram): void {
  if (
    [
      program.getProjectReferenceRedirect,
      program.getResolvedProjectReferenceToRedirect,
    ].some((method) => typeof method !== 'function')
  )
    throw new NativeObservationError(
      'unsupported',
      'Native reference map unavailable.',
    );
}
function hasReferences(program: ts.Program): boolean {
  return (program.getProjectReferences()?.length ?? 0) > 0;
}
