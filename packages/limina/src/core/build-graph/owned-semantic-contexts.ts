import type { ResolvedLiminaConfig } from '#config/runner';
import { AstroSemanticContextManager } from '../astro-semantic/context';
import { SvelteSemanticContextManager } from '../svelte-semantic/context';
import { VueSemanticContextManager } from '../vue-semantic/context';
import type { PrepareGeneratedTsconfigGraphOptions } from './types';

export function createOwnedVueSemanticContexts(
  options: PrepareGeneratedTsconfigGraphOptions,
): VueSemanticContextManager | undefined {
  return options.importAnalysisContext === undefined
    ? new VueSemanticContextManager(
        undefined,
        options.projectDependencyCaches?.analysisCache,
      )
    : undefined;
}

export function createOwnedAstroSemanticContexts(
  options: PrepareGeneratedTsconfigGraphOptions,
  config: ResolvedLiminaConfig,
): AstroSemanticContextManager | undefined {
  if (options.importAnalysisContext !== undefined) return undefined;
  return new AstroSemanticContextManager({
    governanceRoot: config.governanceRoot,
  });
}

export function createOwnedSvelteSemanticContexts(
  options: PrepareGeneratedTsconfigGraphOptions,
): SvelteSemanticContextManager | undefined {
  return options.importAnalysisContext === undefined
    ? new SvelteSemanticContextManager()
    : undefined;
}

export function disposeOwnedVueSemanticContexts(
  contexts: VueSemanticContextManager | undefined,
): void {
  if (contexts === undefined) return;
  contexts.dispose();
}

export function disposeOwnedAstroSemanticContexts(
  contexts: AstroSemanticContextManager | undefined,
): void {
  if (contexts === undefined) return;
  contexts.dispose();
}

export function disposeOwnedSvelteSemanticContexts(
  contexts: SvelteSemanticContextManager | undefined,
): void {
  if (contexts === undefined) return;
  contexts.dispose();
}
