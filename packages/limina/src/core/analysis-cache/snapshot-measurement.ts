import type { AnalysisSnapshot } from './contracts';
import type { NativeAnalysisCache } from './native-cache';
import { newSnapshot } from './snapshot-records';
export function measuredSnapshot(cache: NativeAnalysisCache): AnalysisSnapshot {
  const start = performance.now();
  try {
    return newSnapshot(cache);
  } finally {
    cache.metrics.snapshotCopyMs =
      (cache.metrics.snapshotCopyMs ?? 0) + performance.now() - start;
  }
}
