import type { ResolvedLiminaInputs } from '#config/runner';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { ValidatedWorkspaceContext } from '../workspace/validated-context';
import {
  admittedCachedGraph,
  type CachedGraphData,
  type StoredGraphData,
} from './analysis-cache-schema';
import { restoreGraphContexts } from './analysis-cache-vue';
import { rebindCachedCompilation } from './cached-candidate-binding';
import { replayCurrentOwnership } from './cached-ownership-replay';
import { hasBoundCachedReferences } from './cached-reference-reconstruction';
import { reconstructVueReferences } from './cached-vue-references';
import type { FrameworkInferenceAmbiguity } from './core-collection-run';
import { validateRestoredReferences } from './reference-validation';

interface Binding {
  cache: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  workspace: ValidatedWorkspaceContext;
  stored: StoredGraphData;
  contextIds: readonly string[];
  generation: number;
}

export interface BoundCachedGraph {
  graph: CachedGraphData;
  ambiguities: readonly FrameworkInferenceAmbiguity[];
}

/**
Restored semantic contexts supply evidence; graph projections grant no authority.
*/
export async function bindCachedGraph(
  input: Binding,
): Promise<BoundCachedGraph | undefined> {
  const restored = restoreGraphContexts({ ...input, data: input.stored });
  if (restored === undefined) return undefined;
  rebindCachedCompilation(restored, input.cache);
  try {
    const ownership = await replayCurrentOwnership(
      restored,
      input.config,
      input.workspace,
    );
    if (ownership === undefined) return undefined;
    const graph = validateReferences(input, restored);
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
): CachedGraphData | undefined {
  try {
    const references = reconstructVueReferences({ ...input, graph });
    validateRestoredReferences(graph);
    const isValid = [
      hasBoundCachedReferences(graph, input.config, references),
      admittedCachedGraph(graph) !== undefined,
    ].every(Boolean);
    return isValid ? graph : undefined;
  } catch {
    return undefined;
  }
}
