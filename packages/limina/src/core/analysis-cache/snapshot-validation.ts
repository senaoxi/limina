import ts from 'typescript';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { hasValidBoundedContext } from './bounded-context-validity';
import type { AnalysisSnapshot, InputDependency } from './contracts';
import { analysisHash } from './identity';
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
    const { inventory, snapshot: evidence } = context.native;
    const { members, syntax } = inventory;
    const files = new Set(syntax.map((entry) => entry.file));
    const sources = new Map(
      evidence.requests.map((request) => [
        request.id,
        request.sourceFile?.lexicalPath,
      ]),
    );
    return [
      files.size !== syntax.length,
      files.size !== members.length,
      members.some((file) => !files.has(file)),
      syntax.some(
        ({ file, fingerprint }) =>
          nativeFingerprint(snapshot.files[file]) !== fingerprint,
      ),
      inventory.modules.some(({ requestId, sourceFingerprint }) => {
        const file = sources.get(requestId);
        return (
          file === undefined ||
          snapshot.files[file]?.sourceVersion !== sourceFingerprint
        );
      }),
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
export function validatedSnapshot(
  snapshot: AnalysisSnapshot,
): AnalysisSnapshot | undefined {
  const records = [
    ...Object.values(snapshot.queries),
    ...Object.values(snapshot.importers),
    ...Object.values(snapshot.contexts),
    ...Object.values(snapshot.vueContexts),
    ...Object.values(snapshot.vueContexts).map(
      (context) => context.environment,
    ),
    ...Object.values(snapshot.contexts).map((context) => context.environment),
    ...Object.values(snapshot.contexts).map(
      (context) => context.sharedEnvironment,
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
    hasBrokenQueries(snapshot),
    hasBrokenSources(snapshot),
    hasBrokenFacts(snapshot),
    hasBrokenSyntax(snapshot),
    Object.entries(snapshot.vueContexts).some(
      ([id, context]) => !isVueRecordValid(id, context),
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
