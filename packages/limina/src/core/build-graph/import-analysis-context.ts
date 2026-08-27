import type { ResolvedLiminaConfig } from '#config/runner';
import {
  createImportAnalysisContext,
  type ImportAnalysisContext,
} from '#core/import-graph/context';
import type { AstroSemanticContextManager } from '../astro-semantic/context';
import type { SvelteSemanticContextManager } from '../svelte-semantic/context';
import type { VueSemanticContextManager } from '../vue-semantic/context';
import type { PrepareGeneratedTsconfigGraphOptions } from './types';

export function resolveBuildGraphImportAnalysis(options: {
  astroSemanticContexts?: AstroSemanticContextManager;
  config: ResolvedLiminaConfig;
  importAnalysisContext?: PrepareGeneratedTsconfigGraphOptions['importAnalysisContext'];
  svelteSemanticContexts?: SvelteSemanticContextManager;
  vueSemanticContexts?: VueSemanticContextManager;
}): ImportAnalysisContext {
  if (options.importAnalysisContext !== undefined) {
    return options.importAnalysisContext;
  }
  return createImportAnalysisContext({
    astroSemanticContexts: options.astroSemanticContexts,
    projectRootDir: options.config.rootDir,
    svelteSemanticContexts: options.svelteSemanticContexts,
    vueSemanticContexts: options.vueSemanticContexts,
  });
}
