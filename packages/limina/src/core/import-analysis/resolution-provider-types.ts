import type { AstroSemanticContextManager } from '../astro-semantic/context';
import type { SvelteSemanticContextManager } from '../svelte-semantic/context';
import type { VueSemanticContextManager } from '../vue-semantic/context';
import type { ModuleResolutionRequestIndex } from './request-index';
import type {
  ImportAnalysisCaches,
  ImportAnalysisContext,
  ImportAnalysisMetricsRecorder,
} from './types';

export type ResolutionProvider = Pick<
  ImportAnalysisContext,
  | 'prepareCheckerSemanticDependencies'
  | 'resolveCheckerImportEvidence'
  | 'resolveInternalImport'
  | 'resolveImportEvidence'
  | 'resolveModulePair'
  | 'resolveOxcImport'
  | 'resolveTypeScriptImport'
>;

export interface ProviderDependencies {
  astroSemanticContexts?: AstroSemanticContextManager;
  caches: ImportAnalysisCaches;
  metrics: ImportAnalysisMetricsRecorder | undefined;
  requests: ModuleResolutionRequestIndex;
  svelteSemanticContexts?: SvelteSemanticContextManager;
  vueSemanticContexts?: VueSemanticContextManager;
}
