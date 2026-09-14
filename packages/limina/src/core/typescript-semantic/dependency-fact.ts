import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { createAmbientTypeEvidence } from '../type-evidence/ambient-symbol';
import type { TypeEvidence } from '../type-evidence/cache';
import type {
  TypeScriptSemanticContext,
  TypeScriptSemanticResolution,
} from './contracts';

export interface DeclarationReferenceRequirement {
  kind: 'source-semantic' | 'compiler-membership';
  targetFileName: string;
}

export interface NativeDependencyFact {
  admission: 'admitted' | 'excluded' | 'unresolved';
  referenceRequirement: DeclarationReferenceRequirement | null;
  resolution: TypeScriptSemanticResolution;
  typeEvidence: TypeEvidence;
}

function getSymbolEvidence(options: {
  context: TypeScriptSemanticContext;
  record: ImportRecord;
  tsModule: typeof ts;
}): TypeEvidence {
  const symbol = options.context.getSymbolAtImportRecord(options.record);
  return symbol === undefined
    ? { kind: 'missing' }
    : createAmbientTypeEvidence(symbol, options.tsModule);
}

function getTypeEvidence(options: {
  ambient: TypeEvidence;
  resolution: TypeScriptSemanticResolution;
}): TypeEvidence {
  const target = options.resolution.target;
  if (target === null) return options.ambient;
  const filePath = normalizeAbsolutePath(target.resolvedFileName);
  if (isDeclarationFile(filePath))
    return { filePath, kind: 'concrete-declaration' };
  return getSourceEvidence(options.ambient, filePath);
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
  if (options.typeEvidence.kind === 'checker-source') {
    return { kind: 'source-semantic', targetFileName: target.resolvedFileName };
  }
  return getAmbientRequirement(options);
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
): NativeDependencyFact['admission'] {
  if (resolution.target === null) return 'unresolved';
  return context.hasSourceFile(resolution.target.resolvedFileName)
    ? 'admitted'
    : 'excluded';
}

export function collectNativeDependencyFact(options: {
  context: TypeScriptSemanticContext;
  record: ImportRecord;
  tsModule: typeof ts;
}): NativeDependencyFact {
  const resolution = options.context.resolveImportRecord(options.record);
  const typeEvidence = getTypeEvidence({
    ambient: getSymbolEvidence(options),
    resolution,
  });
  return {
    admission: getAdmission(options.context, resolution),
    referenceRequirement: getRequirement({
      ...options,
      resolution,
      typeEvidence,
    }),
    resolution,
    typeEvidence,
  };
}

function getSourceEvidence(
  ambient: TypeEvidence,
  filePath: string,
): TypeEvidence {
  return ambient.kind === 'ambient'
    ? ambient
    : { filePath, kind: 'checker-source' };
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
