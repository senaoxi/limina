import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import { getResolvedTargetKind } from '../import-graph/declaration-classifier';
import type { createAmbientTypeEvidence } from '../type-evidence/ambient-symbol';
import type { TypeEvidence } from '../type-evidence/cache';
import type {
  TypeScriptSemanticContext,
  TypeScriptSemanticResolution,
} from './contracts';
import {
  collectNativeProviderEvidence,
  isOriginalTargetInProgram,
} from './provider-evidence';

export interface DeclarationReferenceRequirement {
  // An implementation prerequisite, not proof of current type provision.
  kind: 'source-semantic' | 'compiler-membership';
  targetFileName: string;
}

export interface NativeDependencyFact {
  admission: 'admitted' | 'excluded' | 'unresolved';
  referenceRequirement: DeclarationReferenceRequirement | null;
  resolution: TypeScriptSemanticResolution;
  typeEvidence: TypeEvidence;
}

export function hasDeclarationResolution(
  resolution: TypeScriptSemanticResolution,
): boolean {
  if (resolution.target === null) return false;
  return (
    getResolvedTargetKind(resolution.target.resolvedFileName) === 'declaration'
  );
}

function needsCompilerMembership(options: {
  context: TypeScriptSemanticContext;
  resolution: TypeScriptSemanticResolution;
}): boolean {
  const target = options.resolution.target;
  if (target === null) return false;
  if (target.isExternalLibraryImport) return false;
  return !isAlreadyCovered(options.context.program, target.resolvedFileName);
}

function isAlreadyCovered(program: ts.Program, target: string): boolean {
  if (isExplicitInput(program, target)) return true;
  const file = program.getSourceFile(target);
  if (file === undefined) return false;
  return program.isSourceFileFromExternalLibrary(file);
}

function getRequirement(options: {
  context: TypeScriptSemanticContext;
  resolution: TypeScriptSemanticResolution;
  typeEvidence: TypeEvidence;
}): DeclarationReferenceRequirement | null {
  const target = options.resolution.target;
  if (target === null) return null;
  if (hasDeclarationResolution(options.resolution)) return null;
  return getSourceRequirement(options);
}

function getSourceRequirement(options: {
  context: TypeScriptSemanticContext;
  resolution: TypeScriptSemanticResolution;
  typeEvidence: TypeEvidence;
}): DeclarationReferenceRequirement | null {
  if (options.typeEvidence.kind === 'ambient')
    return getAmbientRequirement(options);
  if (options.typeEvidence.kind === 'concrete-declaration') return null;
  return {
    kind: 'source-semantic',
    targetFileName: options.resolution.target!.resolvedFileName,
  };
}

function getAmbientRequirement(options: {
  context: TypeScriptSemanticContext;
  resolution: TypeScriptSemanticResolution;
  typeEvidence: TypeEvidence;
}): DeclarationReferenceRequirement | null {
  if (options.typeEvidence.kind !== 'ambient') return null;
  if (!needsCompilerMembership(options)) return null;
  return {
    kind: 'compiler-membership',
    targetFileName: options.resolution.target!.resolvedFileName,
  };
}

function getAdmission(
  context: TypeScriptSemanticContext,
  resolution: TypeScriptSemanticResolution,
  tsModule: typeof ts,
): NativeDependencyFact['admission'] {
  if (resolution.target === null) return 'unresolved';
  return isOriginalTargetInProgram({
    context,
    target: resolution.target.resolvedFileName,
    tsModule,
  })
    ? 'admitted'
    : 'excluded';
}

export function collectNativeDependencyFact(options: {
  getAmbientEvidence: typeof createAmbientTypeEvidence;
  context: TypeScriptSemanticContext;
  record: ImportRecord;
  tsModule: typeof ts;
}): NativeDependencyFact {
  const resolution = options.context.resolveImportRecord(options.record);
  const typeEvidence = collectNativeProviderEvidence({
    ...options,
    resolution,
  });
  return {
    admission: getAdmission(options.context, resolution, options.tsModule),
    referenceRequirement: getRequirement({
      ...options,
      resolution,
      typeEvidence,
    }),
    resolution,
    typeEvidence,
  };
}

function isExplicitInput(program: ts.Program, target: string): boolean {
  return (
    program.getRootFileNames().includes(target) ||
    isReferencedInput(program, target)
  );
}

function isReferencedInput(program: ts.Program, target: string): boolean {
  return (program.getResolvedProjectReferences() ?? []).some((reference) =>
    reference?.commandLine.fileNames.includes(target),
  );
}
