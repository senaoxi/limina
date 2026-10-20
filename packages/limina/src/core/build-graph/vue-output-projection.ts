import type { VueProjectSemanticIdentity } from '#checkers';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { vueContextId } from '../analysis-cache/vue-identity';
import { createImportAnalysisContext } from '../import-analysis/context';
import type { ImportAnalysisContext } from '../import-analysis/types';
import { effectiveReferenceInputs } from '../project-dependencies/declaration-projection';
import {
  collectProjectDependencies,
  createProjectDependencyCaches,
  createSourceProjectSemanticContext,
} from '../project-dependencies/runner';
import type { TypeScriptSemanticProject } from '../typescript-semantic';
import { VueSemanticContextManager } from '../vue-semantic/context';
import { createVueOutputIdentity } from '../vue-semantic/output-identity';
import type { SourceProject } from './types';

function disposeImportAnalysis(context: ImportAnalysisContext): void {
  context.dispose?.();
}
function persistentContextId(
  cache: NativeAnalysisCache | undefined,
  identity: VueProjectSemanticIdentity,
): string | undefined {
  if (cache === undefined) return undefined;
  return cache.vue.supports(identity) ? vueContextId(identity) : undefined;
}

export function collectVueOutputDependencies(options: {
  project: SourceProject;
  output: TypeScriptSemanticProject;
  cache?: NativeAnalysisCache;
}): { contextId: string | undefined; dependencies: Map<string, string> } {
  const { project, output, cache } = options;
  const source = project.context.vueSemanticIdentity;
  if (source === undefined)
    throw new Error(
      `Vue output projection has no source identity: ${project.configPath}`,
    );
  const identity = createVueOutputIdentity(source, output);
  const contexts = new VueSemanticContextManager(undefined, cache);
  const importAnalysis = createImportAnalysisContext({
    vueSemanticContexts: contexts,
  });
  try {
    const context = createSourceProjectSemanticContext({
      authority: project.semanticAuthority,
      project,
      workspaceSourceBoundary: output.workspaceSourceBoundary,
    });
    const collection = collectProjectDependencies({
      context: {
        ...context,
        configPath: output.configPath,
        resolverConfigPath: output.configPath,
        compilerOptions: output.options,
        references: [],
        vueSemanticIdentity: identity,
      },
      caches: createProjectDependencyCaches(undefined, cache),
      importAnalysis,
    });
    if (collection.failures.length > 0)
      throw new Error(
        `Vue output declaration closure is incomplete: ${project.configPath} -> outputs.target -> ${output.configPath}\n${collection.failures.map((failure) => failure.reason).join('\n')}`,
      );
    return {
      contextId: persistentContextId(cache, identity),
      dependencies: new Map(
        effectiveReferenceInputs(collection).map((dependency) => [
          dependency.referenceRequirement!.targetFileName,
          dependency.importRecord.filePath,
        ]),
      ),
    };
  } finally {
    disposeImportAnalysis(importAnalysis);
    contexts.dispose();
  }
}
