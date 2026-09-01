import type ts from 'typescript';
import {
  createBoundedTypeScriptSemanticContext,
  type TypeScriptSemanticContext,
  type WorkspaceSourceBoundary,
} from '../typescript-semantic';
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
  projectReferences?: readonly ts.ProjectReference[];
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}

function createProgramHandle(
  project: TypeScriptTypeEvidenceProject,
): TypeEvidenceProgramHandle {
  const context = createBoundedTypeScriptSemanticContext(project);
  let disposed = false;

  return {
    dispose(): void {
      context.dispose();
      disposed = true;
    },
    get program(): ts.Program {
      if (disposed) {
        throw new Error('TypeScript type-evidence Program was disposed.');
      }

      return context.program;
    },
    typeScriptSemanticContext: context,
  };
}

export function getOrCreateTypeScriptSemanticContext(options: {
  cache: TypeEvidenceGenerationCache;
  programKey: string;
  project: TypeScriptTypeEvidenceProject;
}): TypeScriptSemanticContext {
  const handle = options.cache.getOrCreateProgram(
    options.programKey,
    () => createProgramHandle(options.project),
    'typescript',
  );
  const context = handle.typeScriptSemanticContext;
  if (context !== undefined) return context;
  throw new Error('Cached TypeScript Program has no semantic context.');
}

function assertProviderActive(disposed: boolean): void {
  if (disposed) {
    throw new Error('TypeScript type-evidence provider was disposed.');
  }
}

function toNullableSymbol(symbol: ts.Symbol | undefined): ts.Symbol | null {
  return symbol ?? null;
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
      const context = getOrCreateTypeScriptSemanticContext(options);
      const symbol = toNullableSymbol(
        context.getSymbolAtImportRecord(importRecord),
      );

      if (!symbol) {
        return { kind: 'missing' };
      }

      return options.cache.getOrCreateAmbientSymbolEvidence(symbol, () =>
        createAmbientTypeEvidence(symbol),
      );
    },
  };
}
