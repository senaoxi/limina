import { AstroSemanticContextManager } from '../astro-semantic/context';
import { SvelteSemanticContextManager } from '../svelte-semantic/context';
import { VueSemanticContextManager } from '../vue-semantic/context';
import { createModuleResolutionRequestIndex } from './request-index';
import { createResolutionProvider } from './resolution-provider';
import {
  clearOxcResolverCaches,
  createImportAnalysisCaches,
} from './resolver-caches';
import { createSourceProvider } from './source-provider';
import type {
  CreateImportAnalysisContextOptions,
  ImportAnalysisContext,
} from './types';

function createOwnedManager<T>(provided: T | undefined, create: () => T) {
  return provided === undefined
    ? { manager: create(), owned: true }
    : { manager: provided, owned: false };
}

function disposeOwnedManager(options: {
  manager: { dispose(): void };
  owned: boolean;
}): void {
  if (options.owned) options.manager.dispose();
}

export function createImportAnalysisContext(
  options: CreateImportAnalysisContextOptions = {},
): ImportAnalysisContext {
  const astro = createOwnedManager(
    options.astroSemanticContexts,
    () => new AstroSemanticContextManager(),
  );
  const svelte = createOwnedManager(
    options.svelteSemanticContexts,
    () => new SvelteSemanticContextManager(),
  );
  const vue = createOwnedManager(
    options.vueSemanticContexts,
    () => new VueSemanticContextManager(),
  );
  const caches = createImportAnalysisCaches();
  const requests = createModuleResolutionRequestIndex({
    caches,
    metrics: options.metrics,
  });
  const source = createSourceProvider({ caches, contextOptions: options });
  const resolution = createResolutionProvider({
    astroSemanticContexts: astro.manager,
    caches,
    metrics: options.metrics,
    requests,
    svelteSemanticContexts: svelte.manager,
    vueSemanticContexts: vue.manager,
  });
  return {
    clearOxcResolverCaches: () => clearOxcResolverCaches(caches),
    collectImportsFromFile: source.collectImportsFromFile,
    dispose: () => {
      disposeOwnedManager(astro);
      disposeOwnedManager(svelte);
      disposeOwnedManager(vue);
    },
    ...resolution,
  };
}
