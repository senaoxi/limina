import ts from 'typescript';
import { nativeContextId } from '../analysis-cache/identity';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { createAmbientTypeEvidence } from '../type-evidence/ambient-symbol';
import { BoundedTypeScriptSemanticContext } from './context';
import type {
  TypeScriptSemanticContext,
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from './contracts';
import {
  NativeCapabilityError,
  ProgramlessDependencyContext,
} from './programless-context';
import type { SourceSyntaxFactsCache } from './syntax-cache';
export * from './context';
export type * from './contracts';
export {
  createTypeScriptProjectDependencyFactsIdentity,
  createTypeScriptSemanticContextIdentity,
} from './identity';
export { createTypeScriptSemanticDependencySnapshot } from './snapshot';
export {
  createWorkspaceSourceBoundary,
  createWorkspaceSourceBoundaryFromProjects,
} from './workspace-source-boundary';
export type { WorkspaceSourceBoundary } from './workspace-source-boundary';

export function createBoundedTypeScriptSemanticContext(
  project: TypeScriptSemanticProject,
  options: {
    dependencyFactsOnly?: boolean;
    syntaxFacts?: SourceSyntaxFactsCache;
    getAmbientEvidence?: typeof createAmbientTypeEvidence;
    analysisCache?: NativeAnalysisCache;
  } = {},
): TypeScriptSemanticContext {
  return new BoundedTypeScriptSemanticContext(
    {
      ...project,
      admissionMode: options.dependencyFactsOnly
        ? 'root-facts'
        : 'full-program',
    },
    ts,
    options,
  );
}

/**
A single graph entry point; compatibility never publishes a partial closure.
*/
export function createTypeScriptDependencyContext(
  project: TypeScriptSemanticProject,
  options: {
    syntaxFacts?: SourceSyntaxFactsCache;
    analysisCache?: NativeAnalysisCache;
  } = {},
): TypeScriptSemanticDependencyContext & { dispose(): void } {
  const effective = { ...project, admissionMode: 'full-program' as const };
  try {
    return new ProgramlessDependencyContext(
      effective,
      options.analysisCache,
      options.syntaxFacts,
    );
  } catch (error) {
    return compatibilityContext(effective, options, error);
  }
}
function compatibilityContext(
  effective: TypeScriptSemanticProject,
  options: NonNullable<Parameters<typeof createTypeScriptDependencyContext>[1]>,
  error: unknown,
): TypeScriptSemanticDependencyContext & { dispose(): void } {
  if (!(error instanceof NativeCapabilityError)) throw error;
  options.analysisCache?.fallback('native-capability');
  const context = createBoundedTypeScriptSemanticContext(effective, options);
  return {
    identity: context.identity,
    getContributionFileNames: () => context.getContributionFileNames?.() ?? [],
    getImportRecords: (file) => context.getImportRecords(file),
    hasSourceFile: (file) => context.hasSourceFile(file),
    getDependencyFact: (record) => context.getDependencyFact(record),
    resolveImportRecord: (record) => context.resolveImportRecord(record),
    dispose() {
      context.dispose();
      recordCompatibility(options.analysisCache, effective, error.message);
    },
  };
}

function recordCompatibility(
  cache: NativeAnalysisCache | undefined,
  project: TypeScriptSemanticProject,
  reason: string,
): void {
  const record = cache?.contexts[nativeContextId(project)];
  if (record !== undefined)
    record.collection = {
      mode: 'compatibility',
      adapter: 'native-requests-v1',
      reason,
    };
}
