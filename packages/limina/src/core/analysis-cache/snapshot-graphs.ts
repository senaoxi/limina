import type { AnalysisSnapshot } from './contracts';

type Records = AnalysisSnapshot['graphs'];
type ProjectionState =
  | { kind: 'unloaded' }
  | { kind: 'loaded'; records: Records }
  | { kind: 'unavailable' };
class UnavailableGraphProjection extends Error {}

/**
An unloaded projection is neither an empty graph nor missing evidence.
*/
export function deferSnapshotGraphs(
  snapshot: AnalysisSnapshot,
  read: () => Records,
): AnalysisSnapshot {
  let state: ProjectionState = { kind: 'unloaded' };
  const load = (): Records => {
    if (state.kind === 'unloaded') {
      try {
        state = { kind: 'loaded', records: read() };
      } catch {
        state = { kind: 'unavailable' };
      }
    }
    if (state.kind === 'unavailable')
      throw new UnavailableGraphProjection(
        'Graph projection block is unavailable.',
      );
    return state.records;
  };
  Object.defineProperty(snapshot, 'graphs', { enumerable: true, get: load });
  return snapshot;
}

export function availableSnapshotGraphs(
  snapshot: AnalysisSnapshot | undefined,
): Records | undefined {
  try {
    return snapshot?.graphs;
  } catch (error) {
    if (error instanceof UnavailableGraphProjection) return undefined;
    throw error;
  }
}
