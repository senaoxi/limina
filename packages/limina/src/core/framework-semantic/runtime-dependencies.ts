import type { ResolvedCheckerModuleName } from '#checkers';
import ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import { findImportRecordLiteral } from '../typescript-semantic/import-record';
import type { FrameworkCompilerRequests } from './compiler-requests';

export interface FrameworkRuntimeModuleResult {
  mode: ts.ResolutionMode;
  resolved: ts.ResolvedModuleFull | undefined;
}

export type FrameworkRuntimeModuleResolver = (
  source: ts.SourceFile,
  literal: ts.StringLiteralLike,
  occurrence: ImportRecord,
) => FrameworkRuntimeModuleResult;

function formatFrameworkRuntimeMode(mode: ts.ResolutionMode): string {
  if (mode === undefined) return 'default';
  return mode === ts.ModuleKind.CommonJS ? 'require' : 'import';
}

interface RuntimeAdapter {
  compiler: typeof ts;
  compilerRequests: FrameworkCompilerRequests;
  program: ts.Program;
  resolve: FrameworkRuntimeModuleResolver;
  target: (resolved: ts.ResolvedModuleFull) => ResolvedCheckerModuleName;
}

export function resolveFrameworkRuntimeOccurrence(
  options: RuntimeAdapter & {
    occurrence: ImportRecord;
  },
): { target: ResolvedCheckerModuleName | null; resolutionMode: string } {
  const { occurrence, program } = options;
  const source = program.getSourceFile(occurrence.filePath);
  if (source === undefined)
    throw new Error(
      `The bounded checker Program did not admit runtime importer ${occurrence.filePath}.`,
    );
  const request = options.compilerRequests.sourceImport(
    program,
    source,
    occurrence,
  );
  let result: FrameworkRuntimeModuleResult;
  if (request === undefined) {
    const literal = findImportRecordLiteral({
      importRecord: occurrence,
      sourceFile: source,
      tsModule: options.compiler,
    });
    if (literal === null)
      throw new Error(
        'The runtime occurrence did not identify a Program literal.',
      );
    result = options.resolve(source, literal, occurrence);
  } else {
    if (request.raw === undefined)
      throw new Error(
        'The checker compiler request has no qualified resolution.',
      );
    result = { mode: request.mode, resolved: request.raw.resolvedModule };
  }
  return {
    target:
      result.resolved === undefined ? null : options.target(result.resolved),
    resolutionMode: formatFrameworkRuntimeMode(result.mode),
  };
}
