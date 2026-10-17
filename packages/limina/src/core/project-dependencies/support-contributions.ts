import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptSemanticDependencyContext } from '../typescript-semantic';
import { isDependencyContributionInput } from '../typescript-semantic/contribution-inputs';
import type {
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from './contracts';
import { collectProjectDependencyRecord } from './direct-dependency-record';

function collectNativeSupportFile(options: {
  collection: ProjectDependencyCollection;
  request: ProjectDependencyRequest;
  context: TypeScriptSemanticDependencyContext;
  fileName: string;
}): void {
  for (const importRecord of options.context.getImportRecords(
    options.fileName,
  )) {
    const fact = options.context.getDependencyFact(importRecord);
    if (fact.referenceRequirement === null) continue;
    collectProjectDependencyRecord({ ...options, importRecord });
  }
}
function contributionFiles(
  context: TypeScriptSemanticDependencyContext,
): readonly string[] {
  return context.getContributionFileNames?.() ?? [];
}
function collectNativeSupport(options: {
  collection: ProjectDependencyCollection;
  request: ProjectDependencyRequest;
  context: TypeScriptSemanticDependencyContext;
}): void {
  const roots = new Set(options.request.context.fileNames);
  for (const fileName of contributionFiles(options.context)) {
    if (!roots.has(fileName))
      collectNativeSupportFile({ ...options, fileName });
  }
}
export function collectSupportContributions(
  collection: ProjectDependencyCollection,
  request: ProjectDependencyRequest,
): void {
  const context = request.typeScriptSemanticContext;
  if (
    context === undefined ||
    request.context.semanticAuthority.family === 'vue'
  )
    return;
  collectNativeSupport({ collection, request, context });
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
function canContribute(
  request: ProjectDependencyRequest,
  file: string,
): boolean {
  return isDependencyContributionInput(
    {
      configPath: request.context.configPath,
      fileNames: request.context.fileNames,
      options: request.context.compilerOptions,
      workspaceSourceBoundary: request.context.workspaceSourceBoundary,
    },
    file,
  );
}
function collectVueSupportInput(
  collection: ProjectDependencyCollection,
  request: ProjectDependencyRequest,
  input: { records: readonly ImportRecord[] },
): void {
  const support: ProjectDependencyCollection = {
    dependencies: [],
    failures: [],
    observations: [],
  };
  for (const importRecord of input.records)
    collectProjectDependencyRecord({
      collection: support,
      importRecord,
      request,
    });
  collection.dependencies.push(
    ...support.dependencies.filter(
      (dependency) => dependency.referenceRequirement !== null,
    ),
  );
  collection.failures.push(...support.failures);
}
export function collectVueSupportContributions(
  collection: ProjectDependencyCollection,
  request: ProjectDependencyRequest,
): void {
  const roots = new Set(request.context.fileNames);
  const files = vueSupportFiles(request).filter(
    (file) =>
      !roots.has(file.filePath) && canContribute(request, file.filePath),
  );
  for (const file of files) collectVueSupportInput(collection, request, file);
}
