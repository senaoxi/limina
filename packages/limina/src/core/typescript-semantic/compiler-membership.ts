import type ts from 'typescript';
import type { CompilerMembership } from '../dependency-semantics';
import { compilerFileKey } from './compiler-coverage';

function hasOriginalReferenceInput(
  program: ts.Program,
  targetKey: string,
  fileKey: (file: string) => string,
): boolean {
  return (program.getResolvedProjectReferences() ?? []).some((reference) =>
    reference?.commandLine.fileNames.some(
      (file) => fileKey(file) === targetKey,
    ),
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
  fileKey: (file: string) => string = compilerFileKey,
): CompilerMembership {
  const targetKey = fileKey(target);
  return [
    program.getRootFileNames().some((file) => fileKey(file) === targetKey),
    hasOriginalReferenceInput(program, targetKey, fileKey),
    hasExternalInput(program, target),
  ].some(Boolean)
    ? 'covered'
    : 'not-covered';
}
