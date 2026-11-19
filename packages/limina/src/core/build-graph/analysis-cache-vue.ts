import { captureFrameworkExecutionReceipt } from '../analysis-cache/framework-execution-inputs';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { vueContextId } from '../analysis-cache/vue-identity';
import type {
  CachedGraphData,
  StoredGovernedSource,
  StoredGraphData,
} from './analysis-cache-schema';
import type { GovernedSourceUnit } from './types';

function mapGovernedSources<Input, Output>(
  sources: Map<string, Map<string, Input>>,
  transform: (unit: Input) => Output | undefined,
): Map<string, Map<string, Output>> | undefined {
  const mapped = new Map<string, Map<string, Output>>();
  for (const [checker, units] of sources) {
    const group = new Map<string, Output>();
    for (const [file, unit] of units) {
      const value = transform(unit);
      if (value === undefined) return undefined;
      group.set(file, value);
    }
    mapped.set(checker, group);
  }
  return mapped;
}

function storeUnit(unit: GovernedSourceUnit): StoredGovernedSource | undefined {
  const { vueSemanticIdentity, ...context } = unit.context;
  const stored = {
    ...unit,
    astroSemanticProject: undefined,
    svelteSemanticProject: undefined,
    context: vueSemanticIdentity
      ? { ...context, vueContextId: vueContextId(vueSemanticIdentity) }
      : context,
  };
  if (unit.frameworkCapabilities.length === 0) return stored;
  const receipt = captureFrameworkExecutionReceipt(unit);
  return receipt === undefined
    ? undefined
    : { ...stored, frameworkExecutionInputs: receipt };
}

export function storeGraphContexts(
  data: CachedGraphData,
): StoredGraphData | undefined {
  const governedSources = mapGovernedSources(data.governedSources, storeUnit);
  return governedSources === undefined
    ? undefined
    : { ...data, governedSources };
}

function restoreUnit(
  unit: StoredGovernedSource,
  cache: NativeAnalysisCache,
  allowed: ReadonlySet<string>,
  generation: number,
): GovernedSourceUnit | undefined {
  const { vueContextId, ...context } = unit.context;
  const restored = { ...unit, context };
  delete restored.frameworkExecutionInputs;
  if (vueContextId !== undefined) {
    if (!allowed.has(vueContextId)) return undefined;
    const identity = cache.vue.identity(vueContextId, generation);
    if (identity?.configPath !== unit.configPath) return undefined;
    return {
      ...restored,
      context: { ...context, vueSemanticIdentity: identity },
    };
  }
  return unit.semanticAuthority.family === 'vue' ? undefined : restored;
}

export function restoreGraphContexts(options: {
  cache: NativeAnalysisCache;
  data: StoredGraphData;
  contextIds: readonly string[];
  generation: number;
}): CachedGraphData | undefined {
  const allowed = new Set(options.contextIds);
  const governedSources = mapGovernedSources(
    options.data.governedSources,
    (unit) => restoreUnit(unit, options.cache, allowed, options.generation),
  );
  return governedSources === undefined
    ? undefined
    : { ...options.data, governedSources };
}
