import type {
  ImporterRecord,
  InputDependency,
  ResolutionRecord,
} from './contracts';
import { analysisHash } from './identity';
import type { NativeAnalysisCache } from './native-cache';

export function usedSnapshotQueries(
  cache: NativeAnalysisCache,
  importers: Record<string, ImporterRecord>,
): Set<string> {
  const used = new Set(cache.retainedQueryIds);
  const consumers = [
    ...Object.values(importers),
    ...Object.values(cache.contexts),
    ...Object.values(cache.contexts).map(
      (context) => context.sharedEnvironment,
    ),
  ];
  for (const record of consumers) addQueries(used, record.queryIds);
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
    runtimeQueries: Record<string, ResolutionRecord>;
  },
): Set<string> {
  // Stream every forward receipt without allocating an expanded copy of the
  // transitive dependency lists. Pruning uses the same complete reachability.
  const referenced = new Set(cache.inputs.configInputs);
  // A governed file can be observed before a reusable semantic context exists.
  for (const { path, version } of cache.epoch.governedSourceInputs()) {
    const id = JSON.stringify(['physical', 'content', path]);
    const source = cache.inputs.records[id];
    if (source !== undefined && analysisHash(source.version) === version)
      referenced.add(id);
  }
  const contexts = [
    ...Object.values(cache.contexts),
    ...Object.values(cache.vue.records),
  ];
  for (const context of contexts) {
    addInputs(referenced, context.dependencies);
    addInputs(referenced, context.environment.dependencies);
    if ('sharedEnvironment' in context)
      addInputs(referenced, context.sharedEnvironment.dependencies);
  }
  addDependencies(referenced, Object.values(records.queries));
  addDependencies(referenced, Object.values(records.runtimeQueries));
  addDependencies(referenced, Object.values(records.importers));
  return referenced;
}
