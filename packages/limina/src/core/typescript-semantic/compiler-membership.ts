import type ts from 'typescript';
import type { CompilerMembership } from '../dependency-semantics';

function hasOriginalReferenceInput(
  program: ts.Program,
  target: string,
): boolean {
  return (program.getResolvedProjectReferences() ?? []).some((reference) =>
    reference?.commandLine.fileNames.includes(target),
  );
}
function hasExternalInput(program: ts.Program, target: string): boolean {
  const file = program.getSourceFile(target);
  return file !== undefined && program.isSourceFileFromExternalLibrary(file);
}
/**
 * Admission alone does not cover an implementation compilation obligation.
 */
export function observeCompilerMembership(
  program: ts.Program,
  target: string,
): CompilerMembership {
  return [
    program.getRootFileNames().includes(target),
    hasOriginalReferenceInput(program, target),
    hasExternalInput(program, target),
  ].some(Boolean)
    ? 'covered'
    : 'not-covered';
}
