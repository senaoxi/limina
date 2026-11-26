import { nativeCollectionStatus } from '../../domain/analysis/native-collection';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from '../typescript-semantic/contracts';
import { getEffectiveImporterRoots } from '../typescript-semantic/effective-roots';
import type { FileDependencyFacts } from '../typescript-semantic/file-dependency-facts';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { hasValidBoundedContext } from './bounded-context-validity';
import { boundedQueryReceipts } from './bounded-query-receipts';
import {
  AnalysisInputDriftError,
  type DiscoveryRecord,
  type ImporterRecord,
  type NativeContextRecord,
  type ProjectRecord,
} from './contracts';
import { analysisHash, nativeContextId } from './identity';
import type { NativeAnalysisCache } from './native-cache';
import { occurrenceKey } from './semantic-state';
import { retainData } from './snapshot-records';
import { observeTypeEnvironment } from './type-environment';

interface Capture {
  context: TypeScriptSemanticDependencyContext;
  project: TypeScriptSemanticProject;
  cache: NativeAnalysisCache;
  discovery: DiscoveryRecord[] | undefined;
  queryIds: Set<string>;
  requireComplete?: boolean;
}

interface SyntaxRecord {
  file: string;
  fingerprint: string;
  facts: FileDependencyFacts;
}

interface BoundedCandidate {
  id: string;
  record: Omit<NativeContextRecord, 'environment' | 'dependencies'> & {
    native: NonNullable<NativeContextRecord['native']>;
  };
  project: ProjectRecord;
  importers: Record<string, ImporterRecord>;
  syntax: SyntaxRecord[];
}

/**
Bounded facts subscribe to every actual compiler read, including negative probes.
A composed candidate must qualify in full before it can replace retained records.
*/
export function captureBoundedContext(
  input: Capture,
): NativeContextRecord | undefined {
  let candidate: BoundedCandidate | undefined;
  try {
    candidate = captureCandidate(input);
    if (
      input.requireComplete &&
      (candidate === undefined || !isCompleteCandidate(input.cache, candidate))
    )
      return undefined;
  } catch (error) {
    if (input.requireComplete && !(error instanceof AnalysisInputDriftError))
      return undefined;
    throw error;
  }
  if (candidate === undefined) {
    input.cache.noteNativeCollection(input.project, false);
    input.cache.qualifyFacts(input.project, false);
    return undefined;
  }
  adoptCandidate(input, candidate);
  return input.cache.contexts[candidate.id];
}

function captureCandidate(input: Capture): BoundedCandidate | undefined {
  const { cache, context, project, discovery } = input;
  const { nativeEvidence: snapshot, nativeInventory: inventory } = context;
  const members = context.getContributionFileNames?.();
  const typeEntries = context.getTypeEnvironmentEntries?.();
  const queryIds = [...input.queryIds];
  if (
    snapshot === undefined ||
    inventory === undefined ||
    discovery === undefined ||
    members === undefined ||
    typeEntries === undefined ||
    queryIds.some((key) => cache.queries[key] === undefined)
  )
    return undefined;

  const id = nativeContextId(project);
  const queriesByFile = Map.groupBy(queryIds, (key) => cache.queries[key].file);
  const options = effectiveCompilerOptions(project.options);
  const environmentVersion = analysisHash(options);
  const membershipVersion = analysisHash(project.fileNames);
  const sources: NativeContextRecord['sources'] = {};
  const importers: Record<string, ImporterRecord> = {};
  for (const file of members) {
    const importer = analysisHash([id, file]);
    sources[file] = importer;
    importers[importer] = captureBoundedImporter(input, {
      contextId: id,
      filePath: file,
      environmentVersion,
      membershipVersion,
      queryIds: queriesByFile.get(file) ?? [],
    });
  }
  const status = nativeCollectionStatus(snapshot);
  const record: BoundedCandidate['record'] = {
    native: {
      snapshot,
      inventory,
      queryReceipts: boundedQueryReceipts(cache.queries, queryIds),
      discovery,
      boundaryIdentity: project.workspaceSourceBoundary.identity,
    },
    typeEntries: [...typeEntries],
    project: {
      configPath: project.configPath,
      options,
      fileNames: [...project.fileNames],
      projectReferences: project.projectReferences,
      analysisBinding: project.analysisBinding,
      sourceConfigPath: project.sourceConfigPath,
      admissionMode: 'coverage-bounded',
      compilationObligationScope: project.compilationObligationScope,
    },
    queryIds,
    sharedEnvironment: {
      dependencies: [],
      queryIds: [],
      version: analysisHash(snapshot.contexts),
    },
    boundary: [],
    sources,
    complete:
      status.execution === 'completed' &&
      status.traversal === 'complete-within-boundary' &&
      queryIds.every((key) => cache.queries[key].coverage === 'complete'),
  };
  return {
    id,
    record,
    project: {
      roots: getEffectiveImporterRoots(project),
      members: [...members],
      environment: [],
      references: project.projectReferences ?? [],
    },
    importers,
    syntax: inventory.syntax.flatMap((witness) => {
      const facts = context.getFileDependencyFacts?.(witness.file);
      return facts === undefined ? [] : [{ ...witness, facts }];
    }),
  };
}

function captureBoundedImporter(
  input: Capture,
  importer: Pick<
    ImporterRecord,
    | 'contextId'
    | 'filePath'
    | 'queryIds'
    | 'environmentVersion'
    | 'membershipVersion'
  >,
): ImporterRecord {
  const occurrences = [...input.context.getImportRecords(importer.filePath)];
  const source = input.cache.inputs.observe(importer.filePath, 'content');
  return {
    ...importer,
    sourceVersion: source.expectedVersion,
    dependencies: [source],
    occurrences,
    facts: Object.fromEntries(
      occurrences.map((occurrence) => [
        occurrenceKey(occurrence),
        input.context.getDependencyFact(occurrence),
      ]),
    ),
    coverage: 'complete',
  };
}

function isCompleteCandidate(
  cache: NativeAnalysisCache,
  candidate: BoundedCandidate,
): boolean {
  const { id, record, project, importers } = candidate;
  const { snapshot, inventory } = record.native;
  const previous = cache.contexts[id] ?? cache.previous?.contexts[id];
  const roots = Map.groupBy(
    snapshot.completeness.filter(
      (entry) =>
        entry.contextId === snapshot.contexts[0]?.id &&
        entry.channel === 'implicit' &&
        entry.state !== 'gap',
    ),
    (entry) => entry.entryId,
  );
  return (
    record.complete &&
    previous !== undefined &&
    inventory.inclusions !== undefined &&
    record.project.fileNames.every((file) => roots.get(file)?.length === 1) &&
    hasValidBoundedContext(
      {
        ...record,
        environment: previous.environment,
        dependencies: previous.dependencies,
      },
      importers,
      { project, contextId: id, queries: cache.queries },
    ) &&
    hasConsistentSyntax(cache, candidate)
  );
}

function hasConsistentSyntax(
  cache: NativeAnalysisCache,
  candidate: BoundedCandidate,
): boolean {
  const { record, importers, syntax } = candidate;
  const { inventory, snapshot } = record.native;
  const factsByFile = new Map(syntax.map((item) => [item.file, item.facts]));
  if (
    factsByFile.size !== syntax.length ||
    factsByFile.size !== inventory.syntax.length ||
    factsByFile.size !== inventory.members.length ||
    inventory.members.some((file) => !factsByFile.has(file))
  )
    return false;

  const sources = new Map(
    snapshot.requests.map((request) => [
      request.id,
      request.sourceFile?.lexicalPath,
    ]),
  );
  return (
    syntax.every(({ file, fingerprint, facts }) => {
      const importer = record.sources[file];
      if (importer === null) return false;
      const source =
        cache.inputs.records[importers[importer].dependencies[0].inputId];
      return (
        facts.filePath === file &&
        facts.compilerVersion ===
          snapshot.contexts[0]?.inputs.typescriptVersion &&
        facts.physicalVersion === source.version &&
        facts.sourceVersion ===
          (source.textVersions?.typescript ?? source.textVersions?.utf8) &&
        facts.requests.every(
          (request) => request.occurrence.filePath === file,
        ) &&
        nativeFingerprint(facts) === fingerprint
      );
    }) &&
    inventory.modules.every(({ requestId, sourceFingerprint }) => {
      const file = sources.get(requestId);
      return (
        file !== undefined &&
        factsByFile.get(file)?.sourceVersion === sourceFingerprint
      );
    })
  );
}

function adoptCandidate(input: Capture, candidate: BoundedCandidate): void {
  const { cache } = input;
  const { id, record, project, importers, syntax } = candidate;
  const environment = observeTypeEnvironment(input.project, cache.inputs);
  cache.inputs.consume(environment.dependencies);
  for (const [importer, facts] of Object.entries(importers))
    cache.importers[importer] = retainData(
      cache.previous?.importers[importer],
      facts,
    );
  cache.contexts[id] = retainData(cache.previous?.contexts[id], {
    ...record,
    environment,
    dependencies: environment.dependencies,
  });
  cache.projects[id] = retainData(cache.previous?.projects[id], project);
  for (const { facts, fingerprint } of syntax)
    cache.retainSyntax(facts, fingerprint);
  cache.noteNativeCollection(input.project, record.complete);
  cache.increment('boundedEvidenceContexts');
}
