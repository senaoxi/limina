import { nativeCollectionStatus } from '../../domain/analysis/native-collection';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from '../typescript-semantic/contracts';
import { getEffectiveImporterRoots } from '../typescript-semantic/effective-roots';
import type { DiscoveryRecord, NativeContextRecord } from './contracts';
import { analysisHash, nativeContextId } from './identity';
import { observeTypeEnvironment } from './installation-environment';
import type { NativeAnalysisCache } from './native-cache';
import { occurrenceKey } from './semantic-state';
import { retainData } from './snapshot-records';

interface Capture {
  context: TypeScriptSemanticDependencyContext;
  project: TypeScriptSemanticProject;
  cache: NativeAnalysisCache;
  discovery: DiscoveryRecord[] | undefined;
}

/**
Bounded facts subscribe to every actual compiler read, including negative probes.
Unknown obligations do not make observation incomplete; execution failures do.
*/
export function captureBoundedContext(input: Capture): void {
  const snapshot = input.context.nativeEvidence;
  if (
    [snapshot, input.discovery, input.context.nativeInventory].includes(
      undefined,
    )
  ) {
    input.cache.qualifyFacts(input.project, false);
    return;
  }
  captureQualifiedBoundedContext({
    ...input,
    snapshot: snapshot!,
    discovery: input.discovery!,
  });
}

function captureQualifiedBoundedContext(
  input: Capture & {
    snapshot: NonNullable<
      TypeScriptSemanticDependencyContext['nativeEvidence']
    >;
    discovery: DiscoveryRecord[];
  },
): void {
  const { snapshot } = input;
  const id = nativeContextId(input.project);
  const members = [...input.context.getContributionFileNames!()];
  const sources = Object.fromEntries(
    members.map((file) => [file, captureBoundedImporter(input, file)]),
  );
  const environment = observeTypeEnvironment(
    input.project,
    input.cache.inputs,
    { members },
  );
  const record: NativeContextRecord = {
    native: {
      snapshot,
      inventory: input.context.nativeInventory!,
      discovery: input.discovery,
      boundaryIdentity: input.project.workspaceSourceBoundary.identity,
    },
    typeEntries: [...input.context.getTypeEnvironmentEntries!()],
    project: {
      configPath: input.project.configPath,
      options: effectiveCompilerOptions(input.project.options),
      fileNames: [...input.project.fileNames],
      projectReferences: input.project.projectReferences,
      analysisBinding: input.project.analysisBinding,
      admissionMode: 'coverage-bounded',
      compilationObligationScope: input.project.compilationObligationScope,
    },
    environment,
    dependencies: environment.dependencies,
    queryIds: [],
    sharedEnvironment: {
      dependencies: [],
      queryIds: [],
      version: analysisHash(snapshot.contexts),
    },
    boundary: [],
    sources,
    complete: nativeCollectionStatus(snapshot).execution === 'completed',
  };
  input.cache.contexts[id] = retainData(
    input.cache.previous?.contexts[id],
    record,
  );
  captureBoundedProject(input, id, members);
  input.cache.inputs.consume(record.dependencies);
  input.cache.increment('boundedEvidenceContexts');
}

function captureBoundedImporter(input: Capture, file: string): string {
  const contextId = nativeContextId(input.project);
  const id = analysisHash([contextId, file]);
  const occurrences = [...input.context.getImportRecords(file)];
  const source = input.cache.inputs.observe(file, 'content');
  const record = {
    contextId,
    filePath: file,
    sourceVersion: source.expectedVersion,
    environmentVersion: analysisHash(
      effectiveCompilerOptions(input.project.options),
    ),
    membershipVersion: analysisHash(input.project.fileNames),
    dependencies: [source],
    queryIds: [],
    occurrences,
    facts: Object.fromEntries(
      occurrences.map((occurrence) => [
        occurrenceKey(occurrence),
        input.context.getDependencyFact(occurrence),
      ]),
    ),
    coverage: 'complete' as const,
  };
  input.cache.importers[id] = retainData(
    input.cache.previous?.importers[id],
    record,
  );
  return id;
}

function captureBoundedProject(
  input: Capture,
  id: string,
  members: string[],
): void {
  input.cache.projects[id] = retainData(input.cache.previous?.projects[id], {
    roots: getEffectiveImporterRoots(input.project),
    members,
    environment: [],
    references: input.project.projectReferences ?? [],
  });
}
