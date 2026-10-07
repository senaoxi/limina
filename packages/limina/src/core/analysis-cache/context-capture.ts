import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import type {
  ImporterRecord,
  InputDependency,
  NativeContextRecord,
} from './contracts';
import { analysisHash } from './identity';
import { observeTypeEnvironment } from './installation-environment';
import type { NativeAnalysisCache } from './native-cache';
import type { SemanticState } from './semantic-state';
import { occurrenceKey } from './semantic-state';

interface CaptureOptions {
  cache: NativeAnalysisCache;
  project: TypeScriptSemanticProject;
  state: SemanticState;
  compilerInputs: Iterable<InputDependency>;
}
function sources(options: CaptureOptions): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const file of options.state.projectRecord.roots) {
    if (!options.state.projectRecord.members.includes(file)) continue;
    result[file] = sourceId(options, file);
  }
  return result;
}
function sourceId(options: CaptureOptions, file: string): string | null {
  const importerId = analysisHash([options.state.contextId, file]);
  return options.cache.importers[importerId] === undefined ? null : importerId;
}
export function isCompleteImporter(importer: ImporterRecord): boolean {
  return (
    importer.coverage === 'complete' &&
    importer.occurrences.every(
      (record) => importer.facts[occurrenceKey(record)] !== undefined,
    )
  );
}
function boundary(options: CaptureOptions): [string, boolean][] {
  const paths = new Set([
    ...options.state.projectRecord.members,
    ...options.state.edges.keys(),
    ...options.state.edges.values().flatMap((targets) => targets.values()),
  ]);
  return [...paths].map((file) => [
    file,
    options.project.workspaceSourceBoundary.has(file),
  ]);
}
export function createContextRecord(
  options: CaptureOptions,
): NativeContextRecord {
  const { project, state, cache } = options;
  const environment = observeTypeEnvironment(
    project,
    cache.inputs,
    state.projectRecord.members,
  );
  const importers = Object.values(cache.importers).filter(
    (importer) => importer.contextId === state.contextId,
  );
  const queryIds = Object.entries(cache.queries)
    .filter(([, query]) => query.contextId === state.contextId)
    .map(([id]) => id);
  const dependencies = new Map(
    [
      ...environment.dependencies,
      ...options.compilerInputs,
      ...importers.flatMap((item) => item.dependencies),
      ...queryIds.flatMap((id) => cache.queries[id].dependencies),
      ...state.projectRecord.members.map((file) =>
        cache.inputs.observe(file, 'content'),
      ),
    ].map((dependency) => [dependency.inputId, dependency]),
  );
  const sourceRecords = sources(options);
  return {
    project: {
      configPath: project.configPath,
      fileNames: project.fileNames,
      options: effectiveCompilerOptions(project.options),
      ...(project.projectReferences !== undefined && {
        projectReferences: project.projectReferences,
      }),
      admissionMode: project.admissionMode,
      analysisBinding: project.analysisBinding,
    },
    environment,
    dependencies: dependencies.values().toArray(),
    queryIds,
    sharedEnvironment: {
      dependencies: state.environmentDependencies,
      queryIds: state.environmentQueryIds,
      version: state.environmentVersion,
    },
    boundary: boundary(options),
    sources: sourceRecords,
    complete: [
      cache.hasReusableFacts(project),
      state.projectRecord.roots.every((file) =>
        Object.hasOwn(sourceRecords, file),
      ),
      importers.every(isCompleteImporter),
      queryIds.every((id) => cache.queries[id].coverage === 'complete'),
    ].every(Boolean),
  };
}
