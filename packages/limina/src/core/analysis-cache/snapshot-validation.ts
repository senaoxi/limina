import type { AnalysisSnapshot, InputDependency } from './contracts';
import { decodeData } from './data-codec';
import { occurrenceKey } from './semantic-state';

function hasBrokenInputs(
  snapshot: AnalysisSnapshot,
  records: { dependencies: InputDependency[] }[],
): boolean {
  return records.some((record) =>
    record.dependencies.some(
      (dependency) =>
        snapshot.inputs[dependency.inputId]?.version !==
        dependency.expectedVersion,
    ),
  );
}
function hasBrokenQueries(snapshot: AnalysisSnapshot): boolean {
  const consumers = [
    ...Object.values(snapshot.importers),
    ...Object.values(snapshot.contexts),
    ...Object.values(snapshot.contexts).map(
      (context) => context.sharedEnvironment,
    ),
  ];
  return consumers.some((record) =>
    record.queryIds.some((id) => snapshot.queries[id] === undefined),
  );
}
function hasBrokenSources(snapshot: AnalysisSnapshot): boolean {
  return Object.entries(snapshot.contexts).some(([id, context]) =>
    [
      snapshot.projects[id] === undefined,
      Object.values(context.sources).some(
        (source) =>
          source !== null && snapshot.importers[source]?.contextId !== id,
      ),
    ].some(Boolean),
  );
}
function hasBrokenFacts(snapshot: AnalysisSnapshot): boolean {
  return Object.values(snapshot.importers).some(
    (importer) =>
      importer.coverage === 'complete' &&
      importer.occurrences.some(
        (record) => importer.facts[occurrenceKey(record)] === undefined,
      ),
  );
}
function hasBrokenContributions(snapshot: AnalysisSnapshot): boolean {
  return Object.values(snapshot.contributions)
    .flat()
    .some((contribution) => {
      const id = JSON.stringify([
        'physical',
        'content',
        contribution.occurrence.filePath,
      ]);
      return snapshot.inputs[id]?.version !== contribution.sourceVersion;
    });
}
function isGraphValid(
  snapshot: AnalysisSnapshot,
  graph: AnalysisSnapshot['graphs'][string],
): boolean {
  try {
    decodeData(graph.data);
  } catch {
    return false;
  }
  return graph.contextIds.every((id) => snapshot.contexts[id] !== undefined);
}
export function validatedSnapshot(
  snapshot: AnalysisSnapshot,
): AnalysisSnapshot | undefined {
  const records = [
    ...Object.values(snapshot.graphs),
    ...Object.values(snapshot.queries),
    ...Object.values(snapshot.importers),
    ...Object.values(snapshot.contexts),
    ...Object.values(snapshot.contexts).map((context) => context.environment),
    ...Object.values(snapshot.contexts).map(
      (context) => context.sharedEnvironment,
    ),
    ...Object.values(snapshot.contexts).flatMap(
      (context) => context.environment.domains,
    ),
  ];
  const broken = [
    hasBrokenInputs(snapshot, records),
    hasBrokenQueries(snapshot),
    hasBrokenSources(snapshot),
    hasBrokenFacts(snapshot),
    hasBrokenContributions(snapshot),
    Object.values(snapshot.graphs).some(
      (graph) => !isGraphValid(snapshot, graph),
    ),
  ];
  return broken.some(Boolean) ? undefined : snapshot;
}
