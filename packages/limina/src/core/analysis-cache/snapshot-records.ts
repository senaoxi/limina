import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AnalysisSnapshot, ConfigModuleSnapshot } from './contracts';
import { ANALYSIS_ADAPTER } from './contracts';
import type { NativeAnalysisCache } from './native-cache';

export function currentSnapshotRecords(
  cache: NativeAnalysisCache,
): Omit<AnalysisSnapshot, 'header'> {
  const importers = Object.fromEntries(
    Object.entries(cache.importers).filter(([, importer]) =>
      cache.projects[importer.contextId]?.roots.includes(importer.filePath),
    ),
  );
  const used = new Set([
    ...Object.values(importers).flatMap((importer) => importer.queryIds),
    ...Object.values(cache.contexts).flatMap((context) => context.queryIds),
  ]);
  const queries = Object.fromEntries(
    Object.entries(cache.queries).filter(([id]) => used.has(id)),
  );
  const referenced = new Set([
    ...cache.inputs.configInputs,
    ...Object.values(cache.graphs).flatMap((graph) =>
      graph.dependencies.map((dependency) => dependency.inputId),
    ),
    ...Object.values(cache.contexts).flatMap((context) =>
      context.dependencies.map((dependency) => dependency.inputId),
    ),
    ...Object.values(queries).flatMap((query) =>
      query.dependencies.map((dependency) => dependency.inputId),
    ),
    ...Object.values(importers).flatMap((importer) =>
      importer.dependencies.map((dependency) => dependency.inputId),
    ),
    ...Object.values(cache.contributions.records)
      .flat()
      .map((contribution) =>
        JSON.stringify([
          'physical',
          'content',
          contribution.occurrence.filePath,
        ]),
      ),
  ]);
  const members = new Set(
    Object.values(cache.projects).flatMap((project) => project.members),
  );
  const manifests = new Set(
    [...referenced]
      .map((id) => cache.inputs.records[id].path)
      .filter((file) => file.endsWith('/package.json')),
  );
  const inputs = Object.fromEntries(
    Object.entries(cache.inputs.records).filter(([id, input]) =>
      [
        referenced.has(id),
        members.has(input.path),
        manifests.has(input.path),
      ].some(Boolean),
    ),
  );
  return {
    configModules: cache.configModules,
    inputs,
    queries,
    importers,
    projects: cache.projects,
    contexts: cache.contexts,
    contributions: cache.contributions.records,
    graphs: cache.graphs,
  };
}
export function emptySnapshot(
  identity: string,
  configVersion?: string,
): AnalysisSnapshot {
  return {
    header: {
      schema: 5,
      implementation: ANALYSIS_ADAPTER,
      identity,
      configVersion: configVersion ?? null,
      revision: randomUUID(),
    },
    configModules: emptyConfigModules(),
    inputs: {},
    projects: {},
    queries: {},
    importers: {},
    contributions: {},
    contexts: {},
    graphs: {},
  };
}

export function areSameRecords(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  const keys = Object.keys(current);
  return (
    keys.length === Object.keys(previous).length &&
    keys.every((key) => previous[key] === current[key])
  );
}

export function matchingConfigSnapshot(
  previous: AnalysisSnapshot | undefined,
  identity: string,
  configVersion: string | undefined,
): AnalysisSnapshot | undefined {
  if (previous === undefined) return undefined;
  const matches = [
    configVersion !== undefined,
    previous.header.configVersion === configVersion,
    previous.header.identity === identity,
    previous.header.schema === 5,
    hasCompleteConfigModules(previous),
    previous.header.implementation === ANALYSIS_ADAPTER,
  ];
  return matches.every(Boolean) ? previous : undefined;
}

export function newSnapshot(cache: NativeAnalysisCache): AnalysisSnapshot {
  return structuredClone({
    header: {
      schema: 5,
      implementation: ANALYSIS_ADAPTER,
      identity: cache.identity,
      configVersion: cache.configVersion ?? null,
      revision: randomUUID(),
    },
    ...cache.snapshotRecords(),
  });
}
export function isSameData(previous: unknown, current: unknown): boolean {
  return previous !== undefined && isDeepStrictEqual(previous, current);
}
export function retainData<T>(previous: T | undefined, current: T): T {
  return isSameData(previous, current) ? previous! : current;
}

// Core-only in-memory caches own no configuration loader. Production preflight
// always supplies the invocation's evidence before the store can restore data.
export function emptyConfigModules(): ConfigModuleSnapshot {
  return {
    loader: 'in-memory',
    files: [],
    resolutions: [],
    complete: true,
    dependencies: [],
    otherUnknownReasons: [],
  };
}

export function areSameConfigModuleRecords(
  previous: ConfigModuleSnapshot,
  current: ConfigModuleSnapshot,
): boolean {
  const records = (snapshot: ConfigModuleSnapshot): unknown => ({
    ...snapshot,
    files: snapshot.files.map(({ metadata, ...file }) => ({
      ...file,
      kind: metadata.kind,
    })),
  });
  return isDeepStrictEqual(records(previous), records(current));
}
function hasCompleteConfigModules(snapshot: AnalysisSnapshot): boolean {
  return snapshot.configModules?.complete ?? false;
}
export interface ConfigCacheOptions {
  configVersion?: string;
  configModules?: ConfigModuleSnapshot;
}
function configOptions(
  options: string | ConfigCacheOptions | undefined,
): ConfigCacheOptions {
  return typeof options === 'string'
    ? { configVersion: options }
    : (options ?? {});
}
function cacheConfigModules(
  previous: AnalysisSnapshot | undefined,
  options: ConfigCacheOptions,
): ConfigModuleSnapshot {
  return options.configModules ?? previousConfigModules(previous);
}
export function configCacheState(
  identity: string,
  previous: AnalysisSnapshot | undefined,
  options: string | ConfigCacheOptions | undefined,
): ConfigCacheOptions & {
  configModules: ConfigModuleSnapshot;
  previous?: AnalysisSnapshot;
} {
  const config = configOptions(options);
  const configModules = cacheConfigModules(previous, config);
  const candidate = matchingConfigSnapshot(
    previous,
    identity,
    config.configVersion,
  );
  return {
    ...config,
    configModules,
    previous: matchingModuleRecords(candidate, configModules),
  };
}
function matchingModuleRecords(
  candidate: AnalysisSnapshot | undefined,
  configModules: ConfigModuleSnapshot,
): AnalysisSnapshot | undefined {
  if (candidate === undefined) return undefined;
  return areSameConfigModuleRecords(candidate.configModules, configModules)
    ? candidate
    : undefined;
}
export function isUnchangedCache(cache: NativeAnalysisCache): boolean {
  if (cache.previous === undefined) return false;
  const records = cache.snapshotRecords();
  return Object.entries(records).every(([key, value]) =>
    key === 'configModules'
      ? areSameConfigModuleRecords(
          cache.previous!.configModules,
          cache.configModules,
        )
      : areSameRecords(
          cache.previous![
            key as Exclude<keyof typeof records, 'configModules'>
          ],
          value as Record<string, unknown>,
        ),
  );
}

function previousConfigModules(
  previous: AnalysisSnapshot | undefined,
): ConfigModuleSnapshot {
  return previous?.configModules ?? emptyConfigModules();
}
