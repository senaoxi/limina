import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ProjectReferenceRedirect } from '../dependency-semantics';
import { observedResolutionHost } from './observed-resolution-host';

interface StructuralProgram extends ts.Program {
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
  const redirect = referenceRedirect(program, target, tsModule);
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

function referenceRedirect(
  program: ts.Program,
  target: string,
  compiler: typeof ts,
): ReturnType<NonNullable<StructuralProgram['getRedirectFromSourceFile']>> {
  const method = (program as StructuralProgram).getRedirectFromSourceFile;
  if (method !== undefined) return method.call(program, target);
  if (hasReferences(program))
    throw new Error(
      `Project reference redirect observation is unsupported by TypeScript ${compiler.version}: ${target}`,
    );
  return undefined;
}
function hasReferences(program: ts.Program): boolean {
  return (program.getProjectReferences()?.length ?? 0) > 0;
}
