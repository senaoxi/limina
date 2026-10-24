import { normalizeAbsolutePath } from '#utils/path';
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

export function hasCompilerRoot(
  program: Pick<ts.Program, 'getRootFileNames'>,
  target: string,
): boolean {
  const roots = program.getRootFileNames();
  if (roots.includes(target)) return true;
  const normalized = normalizeAbsolutePath(target);
  return roots.some((root) => normalizeAbsolutePath(root) === normalized);
}
/**
 * Admission alone does not cover an implementation compilation obligation.
 */
export function observeCompilerMembership(
  program: ts.Program,
  target: string,
): CompilerMembership {
  return [
    hasCompilerRoot(program, target),
    hasOriginalReferenceInput(program, target),
    hasExternalInput(program, target),
  ].some(Boolean)
    ? 'covered'
    : 'not-covered';
}
