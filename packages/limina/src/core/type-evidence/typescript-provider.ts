import type { ImportRecord } from '#core/import-analysis/runner';
import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import { createAmbientTypeEvidence } from './ambient-symbol';
import type {
  TypeEvidence,
  TypeEvidenceGenerationCache,
  TypeEvidenceProgramHandle,
  TypeEvidenceProvider,
} from './cache';

export interface TypeScriptTypeEvidenceProject {
  configPath: string;
  fileNames: readonly string[];
  options: ts.CompilerOptions;
}

function createProgramHandle(
  project: TypeScriptTypeEvidenceProject,
): TypeEvidenceProgramHandle {
  const program = ts.createProgram({
    options: project.options,
    rootNames: [...project.fileNames],
  });
  let disposed = false;

  return {
    dispose(): void {
      disposed = true;
    },
    get program(): ts.Program {
      if (disposed) {
        throw new Error('TypeScript type-evidence Program was disposed.');
      }

      return program;
    },
  };
}

function matchesImportRecordRange(
  node: ts.StringLiteralLike,
  sourceFile: ts.SourceFile,
  importRecord: ImportRecord,
): boolean {
  return (
    node.getStart(sourceFile) === importRecord.locator.sourceStart &&
    node.getEnd() === importRecord.locator.sourceEnd
  );
}

function matchesImportRecord(
  node: ts.StringLiteralLike,
  sourceFile: ts.SourceFile,
  importRecord: ImportRecord,
): boolean {
  return (
    node.text === importRecord.specifier &&
    matchesImportRecordRange(node, sourceFile, importRecord)
  );
}

function matchModuleSpecifierNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  importRecord: ImportRecord,
): ts.StringLiteralLike | null {
  if (!ts.isStringLiteralLike(node)) {
    return null;
  }

  return matchesImportRecord(node, sourceFile, importRecord) ? node : null;
}

function findModuleSpecifierNode(
  sourceFile: ts.SourceFile,
  importRecord: ImportRecord,
): ts.StringLiteralLike | null {
  let matched: ts.StringLiteralLike | null = null;
  const visit = (node: ts.Node): void => {
    if (matched) {
      return;
    }

    const candidate = matchModuleSpecifierNode(node, sourceFile, importRecord);
    if (candidate) {
      matched = candidate;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return matched;
}

function assertProviderActive(disposed: boolean): void {
  if (disposed) {
    throw new Error('TypeScript type-evidence provider was disposed.');
  }
}

function toNullableSymbol(symbol: ts.Symbol | undefined): ts.Symbol | null {
  return symbol ?? null;
}

function findImportSymbol(
  program: ts.Program,
  importRecord: ImportRecord,
): ts.Symbol | null {
  const sourceFile = program.getSourceFile(
    normalizeAbsolutePath(importRecord.filePath),
  );
  if (!sourceFile) {
    return null;
  }

  const moduleSpecifier = findModuleSpecifierNode(sourceFile, importRecord);
  if (!moduleSpecifier) {
    return null;
  }

  return toNullableSymbol(
    program.getTypeChecker().getSymbolAtLocation(moduleSpecifier),
  );
}

export function createTypeScriptTypeEvidenceProvider(options: {
  cache: TypeEvidenceGenerationCache;
  programKey: string;
  project: TypeScriptTypeEvidenceProject;
}): TypeEvidenceProvider {
  let disposed = false;

  return {
    dispose(): void {
      disposed = true;
    },
    query({ importRecord }): TypeEvidence {
      assertProviderActive(disposed);
      const programHandle = options.cache.getOrCreateProgram(
        options.programKey,
        () => createProgramHandle(options.project),
        'typescript',
      );
      const symbol = findImportSymbol(programHandle.program, importRecord);

      if (!symbol) {
        return { kind: 'missing' };
      }

      return options.cache.getOrCreateAmbientSymbolEvidence(symbol, () =>
        createAmbientTypeEvidence(symbol),
      );
    },
  };
}
