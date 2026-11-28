import type { ResolvedCheckerModuleName } from '#checkers';
import ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import { collectTypeScriptSourceFileImports } from '../import-analysis/typescript-imports';
import {
  findImportRecordLiteral,
  findImportRecordLiterals,
} from '../typescript-semantic/import-record';
import type { FrameworkCompilerRequests } from './compiler-requests';
import type {
  FrameworkSemanticDependencyPreparation,
  FrameworkSemanticKind,
  PreparedDependencyFact,
} from './contracts';
import type { GeneratedSemanticDependency } from './generated-dependencies';
import type { StrictBackprojection } from './volar-backprojection';

export interface FrameworkRuntimeModuleResult {
  mode: ts.ResolutionMode;
  resolved: ts.ResolvedModuleFull | undefined;
}

export type FrameworkRuntimeModuleResolver = (
  source: ts.SourceFile,
  literal: ts.StringLiteralLike,
  occurrence: ImportRecord,
) => FrameworkRuntimeModuleResult;

export function isFrameworkRuntimeCandidate(record: ImportRecord): boolean {
  return ['commonjs', 'require-resolve', 'jsdoc-import'].includes(record.kind);
}

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

type RuntimePreparation =
  | Extract<FrameworkSemanticDependencyPreparation, { kind: 'unsupported' }>
  | { kind: 'supported'; facts: PreparedDependencyFact[] };

export function collectGeneratedRuntimeFacts(
  options: RuntimeAdapter & {
    framework: FrameworkSemanticKind;
    source: ts.SourceFile;
    projectOccurrence(
      dependency: GeneratedSemanticDependency,
    ): StrictBackprojection;
  },
): RuntimePreparation {
  const { compiler, source } = options;
  const records = collectTypeScriptSourceFileImports({
    filePath: source.fileName,
    sourceFile: source,
    tsModule: compiler,
  }).filter(isFrameworkRuntimeCandidate);
  if (records.length === 0) return { facts: [], kind: 'supported' };
  const compilerLiterals = new Set(
    options.compilerRequests
      .collect(options.program, source)
      .filter((request) => request.role === 'import')
      .map((request) => request.literal),
  );
  const literals = findImportRecordLiterals({
    records,
    sourceFile: source,
    tsModule: compiler,
  });
  const facts: PreparedDependencyFact[] = [];
  for (const [record, literal] of literals) {
    if (literal !== null && compilerLiterals.has(literal)) continue;
    const projection = options.projectOccurrence({
      generatedFilePath: source.fileName,
      literal,
      record,
      sourceFile: source,
    });
    if (projection.kind === 'unmapped') continue;
    if (projection.kind !== 'mapped')
      return {
        kind: 'unsupported',
        stage: projection.kind,
        reason:
          projection.kind === 'source-map-mismatch'
            ? projection.reason
            : 'Runtime module occurrence mapped to multiple source ranges.',
      };
    if (literal === null)
      return {
        kind: 'unsupported',
        stage: 'source-map-mismatch',
        reason:
          'Mapped runtime module occurrence did not identify a Program literal.',
      };
    const result = options.resolve(source, literal, record);
    facts.push({
      framework: options.framework,
      importRecord: projection.sourceRecord,
      provenance: 'strict-source-map',
      resolutionMode: formatFrameworkRuntimeMode(result.mode),
      runtimeOnly: true,
      semanticSpecifier: record.specifier,
      target:
        result.resolved === undefined ? null : options.target(result.resolved),
    });
  }
  return { facts, kind: 'supported' };
}
