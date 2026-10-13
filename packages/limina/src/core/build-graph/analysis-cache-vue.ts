import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { vueContextId } from '../analysis-cache/vue-identity';
import type {
  CachedGraphData,
  StoredGovernedSource,
  StoredGraphData,
} from './analysis-cache-schema';
import type { GovernedSourceUnit } from './types';

function storeUnit(unit: GovernedSourceUnit): StoredGovernedSource {
  const { vueSemanticIdentity, ...context } = unit.context;
  return {
    ...unit,
    context:
      vueSemanticIdentity === undefined
        ? context
        : {
            ...context,
            vueContextId: vueContextId(vueSemanticIdentity),
          },
  };
}

export function storeGraphContexts(data: CachedGraphData): StoredGraphData {
  return {
    ...data,
    governedSources: new Map(
      [...data.governedSources].map(([checker, units]) => [
        checker,
        new Map([...units].map(([file, unit]) => [file, storeUnit(unit)])),
      ]),
    ),
  };
}

function restoreUnit(options: {
  cache: NativeAnalysisCache;
  allowed: ReadonlySet<string>;
  generation: number;
  unit: StoredGovernedSource;
}): GovernedSourceUnit | undefined {
  const { unit } = options;
  const id = unit.context.vueContextId;
  return id === undefined
    ? restoreNativeUnit(unit)
    : restoreVueUnit(options, id);
}
function restoreNativeUnit(
  unit: StoredGovernedSource,
): GovernedSourceUnit | undefined {
  return unit.semanticAuthority.family === 'vue'
    ? undefined
    : { ...unit, context: unit.context };
}
function restoreVueUnit(
  options: Parameters<typeof restoreUnit>[0],
  id: string,
): GovernedSourceUnit | undefined {
  return options.allowed.has(id) ? bindVueUnit(options, id) : undefined;
}
function bindVueUnit(
  options: Parameters<typeof restoreUnit>[0],
  id: string,
): GovernedSourceUnit | undefined {
  const { unit, cache } = options;
  const context = { ...unit.context };
  delete context.vueContextId;
  const identity = cache.vue.identity(id, options.generation);
  return identity?.configPath === unit.configPath
    ? {
        ...unit,
        context: { ...context, vueSemanticIdentity: identity },
      }
    : undefined;
}

export function restoreGraphContexts(options: {
  cache: NativeAnalysisCache;
  data: StoredGraphData;
  contextIds: readonly string[];
  generation: number;
}): CachedGraphData | undefined {
  const governedSources: CachedGraphData['governedSources'] = new Map();
  const allowed = new Set(options.contextIds);
  for (const [checker, units] of options.data.governedSources) {
    const restored = restoreUnits({ ...options, allowed }, units);
    if (restored === undefined) return undefined;
    governedSources.set(checker, restored);
  }
  return { ...options.data, governedSources };
}

function restoreUnits(
  options: Omit<Parameters<typeof restoreUnit>[0], 'unit'>,
  units: Map<string, StoredGovernedSource>,
): Map<string, GovernedSourceUnit> | undefined {
  const restored = new Map<string, GovernedSourceUnit>();
  for (const [file, unit] of units) {
    const current = restoreUnit({ ...options, unit });
    if (current === undefined) return undefined;
    restored.set(file, current);
  }
  return restored;
}
