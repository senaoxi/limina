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
      // TypeScript Program has no explicit disposal API; dropping this handle
      // releases the generation-owned reference.
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

function findModuleSpecifierNode(
  sourceFile: ts.SourceFile,
  importRecord: ImportRecord,
): ts.StringLiteralLike | null {
  let matched: ts.StringLiteralLike | null = null;
  const visit = (node: ts.Node): void => {
    if (matched) {
      return;
    }

    if (
      ts.isStringLiteralLike(node) &&
      node.text === importRecord.specifier &&
      node.getStart(sourceFile) === importRecord.locator.sourceStart &&
      node.getEnd() === importRecord.locator.sourceEnd
    ) {
      matched = node;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return matched;
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
      if (disposed) {
        throw new Error('TypeScript type-evidence provider was disposed.');
      }

      const programHandle = options.cache.getOrCreateProgram(
        options.programKey,
        () => createProgramHandle(options.project),
        'typescript',
      );
      const sourceFile = programHandle.program.getSourceFile(
        normalizeAbsolutePath(importRecord.filePath),
      );

      if (!sourceFile) {
        return { kind: 'missing' };
      }

      const moduleSpecifier = findModuleSpecifierNode(sourceFile, importRecord);

      if (!moduleSpecifier) {
        return { kind: 'missing' };
      }

      const symbol = programHandle.program
        .getTypeChecker()
        .getSymbolAtLocation(moduleSpecifier);

      if (!symbol) {
        return { kind: 'missing' };
      }

      return options.cache.getOrCreateAmbientSymbolEvidence(symbol, () =>
        createAmbientTypeEvidence(symbol),
      );
    },
  };
}
