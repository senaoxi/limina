import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AnalysisSnapshot } from './contracts';
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
      schema: 3,
      implementation: ANALYSIS_ADAPTER,
      identity,
      configVersion: configVersion ?? null,
      revision: randomUUID(),
    },
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
    previous.header.schema === 3,
    previous.header.implementation === ANALYSIS_ADAPTER,
  ];
  return matches.every(Boolean) ? previous : undefined;
}

export function newSnapshot(cache: NativeAnalysisCache): AnalysisSnapshot {
  return structuredClone({
    header: {
      schema: 3,
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
