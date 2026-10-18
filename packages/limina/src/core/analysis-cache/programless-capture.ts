import { compareCodeUnits } from '#utils/collections';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type { ProgramlessDependencyContext } from '../typescript-semantic/programless-context';
import type {
  InputDependency,
  NativeContextRecord,
  ResolutionRecord,
} from './contracts';
import { analysisHash } from './identity';
import { observeTypeEnvironment } from './installation-environment';
import type { NativeAnalysisCache } from './native-cache';
import { occurrenceKey } from './semantic-state';
import { retainData } from './snapshot-records';
interface Capture {
  context: ProgramlessDependencyContext;
  cache: NativeAnalysisCache;
  queries: [string, ResolutionRecord][];
}
function unique(inputs: InputDependency[]): InputDependency[] {
  return new Map(inputs.map((input) => [input.inputId, input]))
    .values()
    .toArray();
}
function captureImporter(
  input: Capture,
  file: string,
): { id: string; dependencies: InputDependency[] } {
  const { context, cache, queries } = input;
  const contextId = context.resolver.contextId;
  const id = analysisHash([contextId, file]);
  const syntax = context.files.get(file)!;
  const fileQueries = queries.filter(([, query]) => query.file === file);
  const dependencies = unique([
    cache.inputs.observe(file, 'content'),
    cache.inputs.observe(file, 'binding'),
    ...fileQueries.flatMap(([, query]) => query.dependencies),
  ]);
  const occurrences = [...context.getImportRecords(file)];
  const record = {
    contextId,
    filePath: file,
    sourceVersion: syntax.sourceVersion,
    environmentVersion: analysisHash(context.project.options),
    membershipVersion: analysisHash(context.project.fileNames),
    dependencies,
    queryIds: fileQueries.map(([key]) => key),
    occurrences,
    facts: Object.fromEntries(
      occurrences.map((record) => [
        occurrenceKey(record),
        context.getDependencyFact(record),
      ]),
    ),
    coverage: coverage(fileQueries),
  };
  cache.importers[id] = retainData(cache.previous?.importers[id], record);
  return { id, dependencies };
}
function coverage(queries: Capture['queries']): 'complete' | 'unknown' {
  return queries.every(([, query]) => query.coverage === 'complete')
    ? 'complete'
    : 'unknown';
}
function createRecord(input: Capture): NativeContextRecord {
  const { context, cache, queries } = input;
  const { project } = context;
  const members = context.files.keys().toArray();
  const environment = observeTypeEnvironment(project, cache.inputs, {
    members,
  });
  const sources: NativeContextRecord['sources'] = {};
  const dependencies = [...environment.dependencies];
  for (const file of members) {
    const importer = captureImporter(input, file);
    sources[file] = importer.id;
    dependencies.push(...importer.dependencies);
  }
  dependencies.push(...queries.flatMap(([, query]) => query.dependencies));
  return {
    typeEntries: [...context.getTypeEnvironmentEntries()],
    collection: { mode: 'programless', adapter: 'native-requests-v1' },
    project: {
      configPath: project.configPath,
      fileNames: [...project.fileNames],
      options: effectiveCompilerOptions(project.options),
      projectReferences: project.projectReferences,
      admissionMode: project.admissionMode,
      analysisBinding: project.analysisBinding,
    },
    environment,
    dependencies: unique(dependencies),
    queryIds: queries.map(([id]) => id),
    sharedEnvironment: {
      dependencies: environment.dependencies,
      queryIds: [],
      version: analysisHash(environment),
    },
    boundary: context.boundary
      .values()
      .map(
        (file) =>
          [file, project.workspaceSourceBoundary.has(file)] as [
            string,
            boolean,
          ],
      )
      .toArray(),
    sources,
    complete:
      project.fileNames.every((file) => sources[file] !== undefined) &&
      coverage(queries) === 'complete',
  };
}
export function captureProgramlessContext(
  context: ProgramlessDependencyContext,
  cache: NativeAnalysisCache,
): void {
  const contextId = context.resolver.contextId;
  const queries = Object.entries(cache.queries).filter(
    ([, query]) => query.contextId === contextId,
  );
  const record = createRecord({ context, cache, queries });
  cache.inputs.consume(record.dependencies);
  cache.contexts[contextId] = retainData(
    cache.previous?.contexts[contextId],
    record,
  );
  const state = {
    roots: [...context.project.fileNames].sort(compareCodeUnits),
    members: context.files.keys().toArray(),
    environment: [],
    references: rawReferences(context),
  };
  cache.projects[contextId] = retainData(
    cache.previous?.projects[contextId],
    state,
  );
  cache.increment('programlessContexts');
}

function rawReferences(context: ProgramlessDependencyContext) {
  return context.project.projectReferences ?? [];
}
