import type { ResolvedCheckerModuleName } from '#checkers';
import { compareCodeUnits } from '#utils/collections';
import {
  normalizeAbsolutePath,
  normalizeAbsolutePathIdentity,
} from '#utils/path';
import type ts from 'typescript';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import { createAmbientTypeEvidence } from '../type-evidence/ambient-symbol';
import type { TypeEvidence } from '../type-evidence/cache';
import type {
  FrameworkSemanticCandidate,
  PreparedDependencyFact,
} from './contracts';

export interface ResolvedFrameworkCandidate {
  candidate: FrameworkSemanticCandidate<
    ts.SourceFile,
    ts.StringLiteralLike,
    unknown
  >;
  resolutionMode: string;
  target: ResolvedCheckerModuleName | null;
}

function cloneManagedSource(
  value: Extract<
    TypeEvidence,
    { kind: 'concrete-declaration' }
  >['managedSource'],
) {
  return value === undefined
    ? undefined
    : { ...value, checkerNames: [...value.checkerNames] };
}

export function cloneTypeEvidence(evidence: TypeEvidence): TypeEvidence {
  if (evidence.kind === 'ambient') {
    return {
      ...evidence,
      declarationFilePaths: [...evidence.declarationFilePaths],
    };
  }
  if (evidence.kind === 'concrete-declaration') {
    return {
      ...evidence,
      managedSource: cloneManagedSource(evidence.managedSource),
    };
  }
  return { ...evidence };
}

function resolveManagedSource(options: {
  checkerName: string;
  filePath: string;
  managedOutputLookup: ManagedOutputDeclarationLookup | undefined;
}) {
  return options.managedOutputLookup?.resolve(
    options.filePath,
    options.checkerName,
  );
}

function createDeclarationEvidence(
  filePath: string,
  managedSource:
    | ReturnType<ManagedOutputDeclarationLookup['resolve']>
    | undefined,
): TypeEvidence {
  if (managedSource === null) {
    return { filePath, kind: 'concrete-declaration' };
  }
  return managedSource === undefined
    ? { filePath, kind: 'concrete-declaration' }
    : { filePath, kind: 'concrete-declaration', managedSource };
}

function resolveConcreteEvidence(options: {
  checkerName: string;
  managedOutputLookup: ManagedOutputDeclarationLookup | undefined;
  target: ResolvedCheckerModuleName;
}): TypeEvidence {
  const filePath = normalizeAbsolutePath(options.target.resolvedFileName);
  if (!isDeclarationFile(filePath)) {
    return { filePath, kind: 'checker-source' };
  }
  return createDeclarationEvidence(
    filePath,
    resolveManagedSource({
      checkerName: options.checkerName,
      filePath,
      managedOutputLookup: options.managedOutputLookup,
    }),
  );
}

function asProgramLiteral(options: {
  candidate: ResolvedFrameworkCandidate['candidate'];
  expectedEnd: number;
  expectedStart: number;
  node: ts.Node;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): ts.StringLiteralLike | null {
  if (!options.tsModule.isStringLiteralLike(options.node)) return null;
  return [
    options.node.text === options.candidate.semanticSpecifier,
    options.node.getStart(options.sourceFile) === options.expectedStart,
    options.node.getEnd() === options.expectedEnd,
  ].every(Boolean)
    ? options.node
    : null;
}

function findProgramLiteral(options: {
  candidate: ResolvedFrameworkCandidate['candidate'];
  program: ts.Program;
  tsModule: typeof ts;
}): ts.StringLiteralLike | null {
  const candidate = options.candidate;
  const sourceFile = options.program.getSourceFile(
    normalizeAbsolutePath(candidate.containingSourceFile.fileName),
  );
  if (sourceFile === undefined) return null;
  const expectedStart = candidate.literal.getStart(
    candidate.containingSourceFile,
  );
  const expectedEnd = candidate.literal.getEnd();
  let matched: ts.StringLiteralLike | null = null;
  const visit = (node: ts.Node): void => {
    if (matched !== null) return;
    const literal = asProgramLiteral({
      candidate,
      expectedEnd,
      expectedStart,
      node,
      sourceFile,
      tsModule: options.tsModule,
    });
    if (literal !== null) {
      matched = literal;
      return;
    }
    options.tsModule.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matched;
}

function createSymbolEvidence(
  symbol: ts.Symbol | undefined,
  tsModule: typeof ts,
): TypeEvidence {
  return symbol === undefined
    ? { kind: 'missing' }
    : createAmbientTypeEvidence(symbol, tsModule);
}

function resolveAmbientEvidence(options: {
  candidate: ResolvedFrameworkCandidate['candidate'];
  checkerName: string;
  program: ts.Program | undefined;
  tsModule: typeof ts;
}): TypeEvidence {
  if (options.program === undefined) {
    return {
      checker: options.checkerName,
      kind: 'unsupported-checker',
      reason:
        'The checker toolchain did not expose a bounded TypeScript Program for generated-literal type evidence.',
    };
  }
  const literal = findProgramLiteral({
    candidate: options.candidate,
    program: options.program,
    tsModule: options.tsModule,
  });
  if (literal === null) {
    return {
      checker: options.checkerName,
      kind: 'unsupported-checker',
      reason:
        'The checker Program did not contain the enumerated generated dependency literal.',
    };
  }
  return createSymbolEvidence(
    options.program.getTypeChecker().getSymbolAtLocation(literal),
    options.tsModule,
  );
}

export function createPreparedFact(options: {
  checkerName: string;
  managedOutputLookup: ManagedOutputDeclarationLookup | undefined;
  program: ts.Program | undefined;
  resolved: ResolvedFrameworkCandidate;
  tsModule: typeof ts;
}): PreparedDependencyFact {
  const { candidate, target } = options.resolved;
  const typeEvidence =
    target === null
      ? resolveAmbientEvidence({
          candidate,
          checkerName: options.checkerName,
          program: options.program,
          tsModule: options.tsModule,
        })
      : resolveConcreteEvidence({
          checkerName: options.checkerName,
          managedOutputLookup: options.managedOutputLookup,
          target,
        });
  return {
    framework: candidate.framework,
    importRecord: {
      ...candidate.sourceRecord,
      locator: { ...candidate.sourceRecord.locator },
      specifier: candidate.semanticSpecifier,
    },
    provenance: 'strict-source-map',
    resolutionMode: options.resolved.resolutionMode,
    semanticSpecifier: candidate.semanticSpecifier,
    target: target === null ? null : { ...target },
    typeEvidence,
  };
}

function canonicalManagedSource(
  evidence: Extract<TypeEvidence, { kind: 'concrete-declaration' }>,
): unknown {
  const source = evidence.managedSource;
  if (source === undefined) return null;
  return {
    checkerNames: [...source.checkerNames].sort(compareCodeUnits),
    declarationFilePath: normalizeAbsolutePathIdentity(
      source.declarationFilePath,
    ),
    mappedSourceFilePath: normalizeAbsolutePathIdentity(
      source.mappedSourceFilePath,
    ),
    reason: source.reason,
    sourceConfigPath: normalizeAbsolutePathIdentity(source.sourceConfigPath),
  };
}

function canonicalTerminalEvidence(
  evidence: Extract<TypeEvidence, { kind: 'missing' | 'unsupported-checker' }>,
): string {
  if (evidence.kind === 'missing') return JSON.stringify([evidence.kind]);
  return JSON.stringify([evidence.kind, evidence.checker, evidence.reason]);
}

function canonicalNonAmbientEvidence(
  evidence: Exclude<TypeEvidence, { kind: 'ambient' }>,
): string {
  if (evidence.kind === 'checker-source') {
    return JSON.stringify([
      evidence.kind,
      normalizeAbsolutePathIdentity(evidence.filePath),
    ]);
  }
  if (evidence.kind === 'concrete-declaration') {
    return JSON.stringify([
      evidence.kind,
      normalizeAbsolutePathIdentity(evidence.filePath),
      canonicalManagedSource(evidence),
    ]);
  }
  return canonicalTerminalEvidence(evidence);
}

export function canonicalTypeEvidenceIdentity(evidence: TypeEvidence): string {
  if (evidence.kind !== 'ambient') return canonicalNonAmbientEvidence(evidence);
  return JSON.stringify([
    evidence.kind,
    evidence.modulePattern,
    evidence.declarationFilePaths
      .map(normalizeAbsolutePathIdentity)
      .sort(compareCodeUnits),
  ]);
}
