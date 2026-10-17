import type ts from 'typescript';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { createAmbientTypeEvidence } from '../type-evidence/ambient-symbol';
import type { TypeScriptInclusionLedger } from './admission';
import { recordNativeProgram } from './cache-lifecycle';
import type { TypeScriptSemanticProject } from './contracts';
import { measureBoundedProgram } from './metrics';
import { prepareTypeScriptSupportInputs } from './support-inputs';
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

export function createStableBoundedProgram(options: {
  project: TypeScriptSemanticProject;
  host: ts.CompilerHost;
  admission: TypeScriptInclusionLedger;
  tsModule: typeof ts;
  syntaxScope: OwnedSyntaxScope;
  reset: () => void;
  analysisCache?: NativeAnalysisCache;
  metrics: SourceSyntaxFactsCache['metrics'] | undefined;
}): ts.Program {
  let program: ts.Program;
  let attempts = 0;
  do {
    if (++attempts > 32)
      throw new Error(
        `TypeScript support inputs did not stabilize: ${options.project.configPath}`,
      );
    prepareTypeScriptSupportInputs(options);
    const revision = options.admission.revision;
    options.admission.beginProgram();
    options.reset();
    recordNativeProgram(options.analysisCache);
    program = measureBoundedProgram(
      () =>
        options.syntaxScope.createProgram({
          host: options.host,
          options: options.project.options,
          projectReferences: options.project.projectReferences,
          rootNames: [...options.project.fileNames],
        }),
      options.metrics,
    );
    // Only compiler-only late requests that invalidate masked reads require rebuilding.
    prepareTypeScriptSupportInputs(options);
    assertStabilizationProgress(options, revision);
  } while (options.admission.needsProgramRebuild());
  return program;
}

function assertStabilizationProgress(
  options: Parameters<typeof createStableBoundedProgram>[0],
  revision: number,
): void {
  if (
    options.admission.needsProgramRebuild() &&
    options.admission.revision === revision
  )
    throw new Error(
      `TypeScript support input stabilization made no progress: ${options.project.configPath}`,
    );
}
