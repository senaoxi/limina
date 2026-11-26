import { isPlainRecord } from '#utils/values';
import type { BoundedObservationPlan } from './bounded-observation-plan';
import type { ResolutionRecord } from './contracts';
import type { NativeAnalysisCache } from './native-cache';

function isRestoredOrigin(
  query: ResolutionRecord,
  restoredFiles: ReadonlySet<string>,
  restoredLibraryNames: ReadonlySet<string>,
): boolean {
  const { request } = query;
  if (!Array.isArray(request)) return false;
  const [channel, , details] = request;
  if (!isPlainRecord(details) || !isPlainRecord(details.origin)) return false;
  const { origin } = details;
  switch (origin.kind) {
    case 'library': {
      return (
        channel === 'library' &&
        typeof origin.libraryFileName === 'string' &&
        restoredLibraryNames.has(origin.libraryFileName)
      );
    }
    case 'source': {
      return (
        (channel === 'module' || channel === 'type') &&
        typeof origin.version === 'string' &&
        restoredFiles.has(query.file)
      );
    }
    default: {
      return false;
    }
  }
}

export function restoreBoundedObservationQueries(
  cache: NativeAnalysisCache,
  plan: BoundedObservationPlan,
  observedIds: ReadonlySet<string>,
  restoredFiles: ReadonlySet<string>,
  restoredLibraryNames: ReadonlySet<string>,
): Set<string> {
  const ids = new Set(observedIds);
  const previous = cache.previous?.queries;
  for (const id of plan.cleanQueryIds) {
    if (ids.has(id)) continue;
    const query = previous?.[id];
    if (
      query === undefined ||
      !isRestoredOrigin(query, restoredFiles, restoredLibraryNames)
    )
      continue;
    cache.restoreQuery(id, query);
    ids.add(id);
  }
  return ids;
}
