import type { ImportRecord } from '../import-analysis/records';
import {
  type ClosureFact,
  projectDeclarationClosure,
} from '../typescript-semantic/declaration-closure';
import { createImportRecordIdentity } from '../typescript-semantic/import-record';
import { projectNativeDeclarationClosure } from '../typescript-semantic/native-closure';
import type {
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from './contracts';
import { addDeclarationProjection } from './declaration-projection';
import { collectProjectDependencyRecord } from './direct-dependency-record';
import { getDependencyCheckerTarget } from './evidence';

export function collectSupportContributions(
  collection: ProjectDependencyCollection,
  request: ProjectDependencyRequest,
): void {
  const context = request.typeScriptSemanticContext;
  if (
    [
      context === undefined,
      request.context.semanticAuthority.family === 'vue',
    ].some(Boolean)
  )
    return;
  const projection = projectNativeDeclarationClosure(
    context!,
    {
      configPath: request.context.configPath,
      fileNames: request.context.fileNames,
      options: request.context.compilerOptions,
      workspaceSourceBoundary: request.context.workspaceSourceBoundary,
    },
    request.managedOutputLookup,
  );
  addDeclarationProjection(collection, request, projection);
  const roots = new Set(request.context.fileNames);
  const supportRecords = projection.records.filter(
    (record) => !roots.has(record.filePath),
  );
  for (const importRecord of supportRecords) {
    collectProjectDependencyRecord({ collection, request, importRecord });
  }
}
function vueSupportFiles(request: ProjectDependencyRequest) {
  return (
    request.importAnalysis.collectCheckerSupportInputs?.({
      checkerPresets: [],
      extensions: [...request.context.extensions],
      semanticFamily: 'vue',
      vueSemanticIdentity: request.context.vueSemanticIdentity,
    }) ?? []
  );
}
function dependencyFact(
  collection: ProjectDependencyCollection,
  record: ImportRecord,
): ClosureFact {
  const dependency = collection.dependencies.find(
    (item) =>
      createImportRecordIdentity(item.importRecord) ===
      createImportRecordIdentity(record),
  );
  if (!dependency) return { target: null, referenceRequirement: null };
  return {
    target: getDependencyCheckerTarget(dependency.evidence),
    referenceRequirement: dependency.referenceRequirement,
    ...checkerQualification(dependency),
  };
}
function checkerQualification(
  dependency: ProjectDependencyCollection['dependencies'][number],
) {
  const evidence = dependency.evidence.checker;
  if (evidence.kind === 'native' || evidence.kind === 'framework')
    return {
      redirect: evidence.fact.redirect,
      eligibility: evidence.fact.eligibility,
    };
  return {};
}

export function collectVueSupportContributions(
  collection: ProjectDependencyCollection,
  request: ProjectDependencyRequest,
): void {
  const roots = new Set(request.context.fileNames);
  const files = new Map(
    vueSupportFiles(request).map((input) => [input.filePath, input.records]),
  );
  const rootRecords = [
    ...collection.dependencies,
    ...collection.observations.filter((item) => 'importRecord' in item),
  ].flatMap((item) => ('importRecord' in item ? [item.importRecord] : []));
  const facts = new Map<string, ClosureFact>();
  const projection = projectDeclarationClosure({
    configPath: request.context.configPath,
    entries: [
      ...request.context.fileNames.map((fileName) => ({
        kind: 'root' as const,
        fileName,
      })),
      ...(request.importAnalysis.collectCheckerTypeEnvironmentEntries?.({
        checkerPresets: [],
        extensions: [...request.context.extensions],
        semanticFamily: 'vue',
        vueSemanticIdentity: request.context.vueSemanticIdentity,
      }) ?? []),
    ],
    noResolve: request.context.compilerOptions.noResolve,
    boundary: request.context.workspaceSourceBoundary,
    managedOutputLookup: request.managedOutputLookup,
    records: (file) =>
      roots.has(file)
        ? rootRecords.filter((record) => record.filePath === file)
        : files.get(file),
    fact: (record) => {
      const key = createImportRecordIdentity(record);
      const cached = facts.get(key);
      if (cached) return cached;
      if (!roots.has(record.filePath))
        collectProjectDependencyRecord({
          collection,
          request,
          importRecord: record,
        });
      const fact = dependencyFact(collection, record);
      facts.set(key, fact);
      return fact;
    },
  });
  addDeclarationProjection(collection, request, projection);
}
