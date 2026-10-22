import { compareCodeUnits } from '#utils/collections';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type { StoredGraphData } from './analysis-cache-schema';
import { projectedReferences } from './candidate-build-plan';
import {
  bindCompilationProjection,
  bindCurrentCompilationContexts,
} from './compilation-prerequisite';

/**
A cached summary cannot change which projects and edges it admits.
*/
export function hasBoundCandidate(graph: StoredGraphData): boolean {
  const candidate = graph.dependencyAnalysis.candidate;
  if (candidate === undefined) return false;
  const configs = graph.governedSources
    .values()
    .flatMap((sources) => sources.keys().toArray())
    .toArray();
  const references = projectedReferences(
    graph.governedSources
      .values()
      .flatMap((sources) => sources.values())
      .toArray(),
  );
  return [
    hasSameSet(candidate.configPaths, configs),
    candidate.schedules.length === 0,
    hasSameSet(
      candidate.references.map(nativeFingerprint),
      references.map(nativeFingerprint),
    ),
    graph.dependencyAnalysis.outcome!.core.dispatch === 'completed',
    graph.dependencyAnalysis.outcome!.core.entries.every(
      (entry) =>
        graph.ownershipPlan.typeConfigs.has(entry.configPath) ||
        entry.phase === 'baseline',
    ),
  ].every(Boolean);
}

function hasSameSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const canonical = (values: readonly string[]) =>
    [...new Set(values)].sort(compareCodeUnits);
  return (
    nativeFingerprint(canonical(left)) === nativeFingerprint(canonical(right))
  );
}

export function rebindCachedCompilation(
  stored: StoredGraphData,
  cache: NativeAnalysisCache,
): void {
  bindCompilationProjection(
    stored.dependencyAnalysis.candidate!,
    stored.governedSources
      .values()
      .flatMap((units) => units.values())
      .toArray(),
  );
  bindCurrentCompilationContexts(
    stored.dependencyAnalysis.candidate!,
    Object.values(cache.contexts).flatMap(
      (record) => record.native?.snapshot.contexts ?? [],
    ),
  );
}
