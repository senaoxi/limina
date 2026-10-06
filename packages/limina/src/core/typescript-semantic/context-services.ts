import type ts from 'typescript';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { createAmbientTypeEvidence } from '../type-evidence/ambient-symbol';
import type { TypeScriptSemanticProject } from './contracts';
import type { SourceSyntaxFactsCache } from './syntax-cache';
import type { OwnedSyntaxScope } from './syntax-input';
export interface ContextServices {
  analysisCache?: NativeAnalysisCache;
  getAmbientEvidence?: typeof createAmbientTypeEvidence;
  syntaxFacts?: SourceSyntaxFactsCache;
}
export function resolveServices(options: ContextServices): {
  getAmbientEvidence: typeof createAmbientTypeEvidence;
  syntaxFacts: SourceSyntaxFactsCache | undefined;
  metrics: SourceSyntaxFactsCache['metrics'] | undefined;
} {
  return {
    getAmbientEvidence: options.getAmbientEvidence ?? createAmbientTypeEvidence,
    syntaxFacts: options.syntaxFacts,
    metrics: options.syntaxFacts?.metrics,
  };
}
export function activeSyntaxScope(
  cache: SourceSyntaxFactsCache | undefined,
  scope: OwnedSyntaxScope,
): OwnedSyntaxScope | undefined {
  return cache === undefined ? undefined : scope;
}

export function resolveAnalysisCache(options: {
  project: TypeScriptSemanticProject;
  tsModule: typeof ts;
  cache: NativeAnalysisCache | undefined;
}): NativeAnalysisCache | undefined {
  return options.cache?.supports(options.project, options.tsModule)
    ? options.cache
    : undefined;
}
