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
import { hasCurrentOwnership } from './cached-ownership-replay';
import { hasBoundCachedReferences } from './cached-reference-reconstruction';
import { reconstructVueReferences } from './cached-vue-references';
import { validateRestoredReferences } from './reference-validation';

interface Binding {
  cache: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  workspace: ValidatedWorkspaceContext;
  stored: StoredGraphData;
  contextIds: readonly string[];
  generation: number;
}

/**
Restored semantic contexts supply evidence; graph projections grant no authority.
*/
export async function bindCachedGraph(
  input: Binding,
): Promise<CachedGraphData | undefined> {
  const restored = restoreGraphContexts({ ...input, data: input.stored });
  if (restored === undefined) return undefined;
  rebindCachedCompilation(restored, input.cache);
  try {
    return (await hasCurrentOwnership(restored, input.config, input.workspace))
      ? validateReferences(input, restored)
      : undefined;
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
