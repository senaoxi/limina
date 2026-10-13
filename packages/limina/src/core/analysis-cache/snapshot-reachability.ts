import type {
  ImporterRecord,
  InputDependency,
  ResolutionRecord,
} from './contracts';
import type { NativeAnalysisCache } from './native-cache';

export function usedSnapshotQueries(
  cache: NativeAnalysisCache,
  importers: Record<string, ImporterRecord>,
): Set<string> {
  const used = new Set<string>();
  for (const record of Object.values(importers))
    addQueries(used, record.queryIds);
  for (const record of Object.values(cache.contexts))
    addQueries(used, record.queryIds);
  return used;
}

function addQueries(used: Set<string>, queries: string[]): void {
  for (const id of queries) used.add(id);
}

function addDependencies(
  referenced: Set<string>,
  records: { dependencies: InputDependency[] }[],
): void {
  for (const record of records) addInputs(referenced, record.dependencies);
}

function addInputs(referenced: Set<string>, inputs: InputDependency[]): void {
  for (const input of inputs) referenced.add(input.inputId);
}

export function referencedSnapshotInputs(
  cache: NativeAnalysisCache,
  records: {
    importers: Record<string, ImporterRecord>;
    queries: Record<string, ResolutionRecord>;
  },
): Set<string> {
  // Stream every forward receipt without allocating an expanded copy of the
  // transitive dependency lists. Pruning uses the same complete reachability.
  const referenced = new Set(cache.inputs.configInputs);
  addDependencies(referenced, Object.values(cache.graphs));
  addDependencies(referenced, Object.values(cache.contexts));
  addDependencies(referenced, Object.values(cache.vue.records));
  addDependencies(referenced, Object.values(records.queries));
  addDependencies(referenced, Object.values(records.importers));
  for (const contributions of Object.values(cache.contributions.records)) {
    for (const contribution of contributions)
      referenced.add(
        JSON.stringify([
          'physical',
          'content',
          contribution.occurrence.filePath,
        ]),
      );
  }
  return referenced;
}
