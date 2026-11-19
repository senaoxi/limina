import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { AstroSemanticContextManager } from '../astro-semantic/context';
import type { ImportAnalysisContext } from '../import-analysis/types';
import { SvelteSemanticContextManager } from '../svelte-semantic/context';
import type { ValidatedWorkspaceContext } from '../workspace/validated-context';
import {
  admittedCachedGraph,
  type CachedGraphData,
  type StoredGraphData,
} from './analysis-cache-schema';
import { restoreGraphContexts } from './analysis-cache-vue';
import { rebindCachedCompilation } from './cached-candidate-binding';
import { hasBoundFrameworkOwnership } from './cached-framework-ownership';
import { reconstructCachedReferences } from './cached-framework-references';
import { replayCurrentOwnership } from './cached-ownership-replay';
import { hasBoundCachedReferences } from './cached-reference-reconstruction';
import { hasBoundFrozenSources } from './cached-semantic-sources';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import type { FrameworkInferenceAmbiguity } from './core-collection-run';
import { resolveBuildGraphImportAnalysis } from './import-analysis-context';
import type { FrozenSemanticProject } from './locked-semantic-project';
import { validateRestoredReferences } from './reference-validation';

interface Binding {
  ownershipInputs: CheckerOwnershipDiscovery;
  cache: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  workspace: ValidatedWorkspaceContext;
  stored: StoredGraphData;
  contextIds: readonly string[];
  generation: number;
  projectConfigCache?: CheckerProjectConfigCache;
  metrics?: AnalysisMetricsRecorder;
  importAnalysisContext?: ImportAnalysisContext;
}

export interface BoundCachedGraph {
  graph: CachedGraphData;
  ambiguities: readonly FrameworkInferenceAmbiguity[];
}

/**
Restored semantic contexts supply evidence; graph projections grant no authority.
*/
export function bindCachedGraph(input: Binding): BoundCachedGraph | undefined {
  const restored = restoreGraphContexts({ ...input, data: input.stored });
  if (restored === undefined) return undefined;
  try {
    const ownership = replayCurrentOwnership(
      restored,
      input.config,
      input.ownershipInputs,
      input.projectConfigCache,
    );
    if (ownership === undefined) return undefined;
    if (
      !hasBoundFrozenSources({
        ...input,
        graph: restored,
        frozenProjectsByConfigPath: ownership.frozenProjectsByConfigPath,
      })
    )
      return undefined;
    rebindCachedCompilation(restored, input.cache);
    const graph = validateReferences(
      input,
      restored,
      ownership.frozenProjectsByConfigPath,
    );
    return graph === undefined
      ? undefined
      : { graph, ambiguities: ownership.ambiguities };
  } catch {
    return undefined;
  }
}

function validateReferences(
  input: Binding,
  graph: CachedGraphData,
  frozenProjectsByConfigPath: ReadonlyMap<string, FrozenSemanticProject>,
): CachedGraphData | undefined {
  const current = input.importAnalysisContext;
  if (current !== undefined)
    return validateFrameworkReferences(
      input,
      graph,
      frozenProjectsByConfigPath,
      current,
    );
  const astro = new AstroSemanticContextManager({
    governanceRoot: input.config.governanceRoot,
  });
  const svelte = new SvelteSemanticContextManager();
  try {
    return validateFrameworkReferences(
      input,
      graph,
      frozenProjectsByConfigPath,
      resolveBuildGraphImportAnalysis({
        config: input.config,
        astroSemanticContexts: astro,
        svelteSemanticContexts: svelte,
      }),
    );
  } finally {
    astro.dispose();
    svelte.dispose();
  }
}

function validateFrameworkReferences(
  input: Binding,
  graph: CachedGraphData,
  frozenProjectsByConfigPath: ReadonlyMap<string, FrozenSemanticProject>,
  importAnalysis: ImportAnalysisContext,
): CachedGraphData | undefined {
  if (
    !hasBoundFrameworkOwnership({
      ...input,
      graph,
      discovery: input.ownershipInputs,
      importAnalysis,
    })
  )
    return undefined;
  const references = reconstructCachedReferences({
    ...input,
    graph,
    frozenProjectsByConfigPath,
    importAnalysis,
  });
  validateRestoredReferences(graph);
  return hasBoundCachedReferences(graph, input.config, references) &&
    admittedCachedGraph(graph) !== undefined
    ? graph
    : undefined;
}
