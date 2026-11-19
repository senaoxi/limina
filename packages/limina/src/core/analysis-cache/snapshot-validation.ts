import ts from 'typescript';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { hasValidBoundedContext } from './bounded-context-validity';
import type { AnalysisSnapshot, InputDependency } from './contracts';
import { validateData } from './data-codec';
import { analysisHash } from './identity';
import { hasBrokenInstallationCoverage } from './installation-lock-coverage';
import { hasResolutionReceipt } from './resolution-queries';
import { occurrenceKey } from './semantic-state';
import { hasVueModuleContextId } from './vue-identity';
import { hasValidVueQuery } from './vue-schema';

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
    ...Object.values(snapshot.graphs),
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

function hasBrokenFile(snapshot: AnalysisSnapshot, file: string): boolean {
  const facts = snapshot.files[file];
  const input = snapshot.inputs[JSON.stringify(['physical', 'content', file])];
  const text = input?.textVersions;
  return [
    facts.filePath !== file,
    facts.compilerVersion !== ts.version,
    input === undefined || input.version !== facts.physicalVersion,
    (text?.typescript ?? text?.utf8) !== facts.sourceVersion,
    facts.requests.some((request) => request.occurrence.filePath !== file),
  ].some(Boolean);
}
function hasBrokenSourceVersion(
  snapshot: AnalysisSnapshot,
  file: string,
  id: string | null,
): boolean {
  return id === null || hasDifferentSourceVersion(snapshot, file, id);
}
function hasBrokenContextSyntax(
  snapshot: AnalysisSnapshot,
  context: AnalysisSnapshot['contexts'][string],
): boolean {
  if (context.native !== undefined) {
    const { members, syntax } = context.native.inventory;
    const files = new Set(syntax.map((entry) => entry.file));
    return [
      files.size !== syntax.length,
      files.size !== members.length,
      members.some((file) => !files.has(file)),
      syntax.some(
        ({ file, fingerprint }) =>
          nativeFingerprint(snapshot.files[file]) !== fingerprint,
      ),
    ].some(Boolean);
  }
  return (
    context.collection?.mode === 'programless' &&
    Object.entries(context.sources).some(([file, id]) =>
      hasBrokenSourceVersion(snapshot, file, id),
    )
  );
}
function hasBrokenSyntax(snapshot: AnalysisSnapshot): boolean {
  return (
    Object.keys(snapshot.files).some((file) => hasBrokenFile(snapshot, file)) ||
    Object.values(snapshot.contexts).some((context) =>
      hasBrokenContextSyntax(snapshot, context),
    )
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
    validateData(graph.data);
  } catch {
    return false;
  }
  return (
    graph.contextIds.every((id) => snapshot.contexts[id] !== undefined) &&
    graph.vueContextIds.every((id) => snapshot.vueContexts[id]?.complete)
  );
}

export function hasValidGraphRecords(
  snapshot: AnalysisSnapshot,
  graphs: AnalysisSnapshot['graphs'],
): boolean {
  const records = Object.values(graphs);
  return (
    !hasBrokenInputs(snapshot, records) &&
    records.every(
      (graph) =>
        graph.queryIds.every((id) => snapshot.queries[id] !== undefined) &&
        isGraphValid(snapshot, graph),
    )
  );
}
export function validatedSnapshot(
  snapshot: AnalysisSnapshot,
): AnalysisSnapshot | undefined {
  const records = [
    ...Object.values(snapshot.graphs),
    ...Object.values(snapshot.queries),
    ...Object.values(snapshot.importers),
    ...Object.values(snapshot.contexts),
    ...Object.values(snapshot.vueContexts),
    ...Object.values(snapshot.vueContexts).map(
      (context) => context.environment,
    ),
    ...Object.values(snapshot.vueContexts).flatMap(
      (context) => context.environment.domains,
    ),
    ...Object.values(snapshot.contexts).map((context) => context.environment),
    ...Object.values(snapshot.contexts).map(
      (context) => context.sharedEnvironment,
    ),
    ...Object.values(snapshot.contexts).flatMap(
      (context) => context.environment.domains,
    ),
  ];
  const broken = [
    Object.entries(snapshot.contexts).some(
      ([id, context]) =>
        !hasValidBoundedContext(context, snapshot.importers, {
          project: snapshot.projects[id],
          contextId: id,
          queries: snapshot.queries,
        }),
    ),
    Object.values(snapshot.queries).some(
      (query) => !hasResolutionReceipt(query),
    ),
    hasBrokenInputs(snapshot, records),
    hasBrokenInstallationCoverage(snapshot),
    hasBrokenQueries(snapshot),
    hasBrokenSources(snapshot),
    hasBrokenFacts(snapshot),
    hasBrokenSyntax(snapshot),
    hasBrokenContributions(snapshot),
    Object.entries(snapshot.vueContexts).some(
      ([id, context]) => !isVueRecordValid(id, context),
    ),
    Object.values(snapshot.graphs).some(
      (graph) => !isGraphValid(snapshot, graph),
    ),
  ];
  return broken.some(Boolean) ? undefined : snapshot;
}

function isVueRecordValid(
  id: string,
  context: AnalysisSnapshot['vueContexts'][string],
): boolean {
  const members = new Set(context.members);
  const dependencies = new Map(
    context.dependencies.map((dependency) => [
      dependency.inputId,
      dependency.expectedVersion,
    ]),
  );
  return [
    analysisHash(context.identity) === id,
    hasVueModuleContextId(context.identity, context.moduleContextId),
    context.queryIds.length === Object.keys(context.queries).length,
    context.queryIds.every((key) => context.queries[key] !== undefined),
    Object.values(context.queries).every((query) =>
      hasValidVueQuery(query.kind, query.data),
    ),
    Object.values(context.moduleResolutions).every(
      (resolution) =>
        resolution.members.every((file) => members.has(file)) &&
        resolution.dependencies.every(
          (dependency) =>
            dependencies.get(dependency.inputId) === dependency.expectedVersion,
        ),
    ),
  ].every(Boolean);
}

function hasDifferentSourceVersion(
  snapshot: AnalysisSnapshot,
  file: string,
  id: string,
): boolean {
  return (
    snapshot.files[file]?.physicalVersion !==
    snapshot.importers[id]?.sourceVersion
  );
}
