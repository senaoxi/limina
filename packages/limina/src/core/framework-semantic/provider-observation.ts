import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import { createAmbientTypeEvidence } from '../type-evidence/ambient-symbol';
import type { TypeEvidence } from '../type-evidence/cache';
import {
  findSourceFileLiterals,
  isObservedJSDocumentLiteral,
} from '../typescript-semantic/source-file-literals';
import type { ResolvedFrameworkCandidate } from './prepared-type-evidence';

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
  const literals = findSourceFileLiterals({
    sourceFile,
    tsModule: options.tsModule,
    matches: (node) =>
      asProgramLiteral({
        candidate,
        expectedEnd,
        expectedStart,
        node,
        sourceFile,
        tsModule: options.tsModule,
      }) !== null,
  });
  return uniqueObservedLiteral(literals, sourceFile, options.tsModule);
}

function uniqueObservedLiteral(
  literals: readonly ts.StringLiteralLike[],
  sourceFile: ts.SourceFile,
  tsModule: typeof ts,
): ts.StringLiteralLike | null {
  if (literals.length !== 1) return null;
  const literal = literals[0]!;
  return isObservedJSDocumentLiteral({
    literal,
    sourceFile,
    tsModule,
  })
    ? literal
    : null;
}

/**
Observe the literal from this Program, never the detached enumeration AST.
*/
export function observeFrameworkTypeEvidence(options: {
  candidate: ResolvedFrameworkCandidate['candidate'];
  checkerName: string;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
  program: ts.Program;
  tsModule: typeof ts;
}): TypeEvidence {
  const literal = findProgramLiteral(options);
  if (literal === null)
    return {
      checker: options.checkerName,
      kind: 'unsupported-checker',
      reason:
        'The checker Program did not contain the enumerated dependency literal.',
    };
  return observeSymbolProvider(
    options.program.getTypeChecker().getSymbolAtLocation(literal),
    options,
  );
}
interface ProviderOptions {
  program: ts.Program;
  checkerName: string;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
  tsModule: typeof ts;
}
function observeSourceProvider(
  symbol: ts.Symbol,
  options: ProviderOptions,
): TypeEvidence {
  const providers = providerFiles(symbol, options.tsModule);
  if (providers.length !== 1) return { kind: 'missing' };
  const provider = providers[0]!;
  return options.program.getSourceFile(provider.fileName) === provider
    ? sourceProviderEvidence(provider, options)
    : { kind: 'missing' };
}
function sourceProviderEvidence(
  provider: ts.SourceFile,
  options: ProviderOptions,
): TypeEvidence {
  const filePath = normalizeAbsolutePath(provider.fileName);
  return provider.isDeclarationFile
    ? createDeclarationEvidence(
        filePath,
        resolveManagedSource({
          ...options,
          filePath,
          managedOutputLookup: options.managedOutputLookup,
        }),
      )
    : { kind: 'checker-source', filePath };
}
function observeSymbolProvider(
  symbol: ts.Symbol | undefined,
  options: ProviderOptions,
): TypeEvidence {
  if (symbol === undefined) return { kind: 'missing' };
  const ambient = createAmbientTypeEvidence(symbol, options.tsModule);
  return ambient.kind === 'ambient'
    ? ambient
    : observeSourceProvider(symbol, options);
}

function providerFiles(
  symbol: ts.Symbol,
  tsModule: typeof ts,
): ts.SourceFile[] {
  return (symbol.declarations ?? []).filter(tsModule.isSourceFile);
}
