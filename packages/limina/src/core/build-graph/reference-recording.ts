import { formatImportRecordLocation } from '#core/import-graph/context';
import { toRelativePath } from '#utils/path';
import {
  getDtsConfigPathForSourcePath,
  getDtsProjectsForSourcePath,
} from './project-indexes';
import {
  formatAmbiguousCrossCheckerProviderProblem,
  formatMissingCrossCheckerProviderProblem,
  formatUnsafeCrossEngineProviderProblem,
} from './provider-problems';
import { selectProviderProject } from './provider-selection';
import type {
  ReferenceImportOptions,
  ReferenceTarget,
} from './reference-import-types';
import { isDeniedGeneratedReference } from './reference-policy';
import type {
  GeneratedProviderEdge,
  ProviderSelectionResult,
  SourceProject,
} from './types';

function addSelectionProblem(options: {
  base: ReferenceImportOptions;
  selection: Exclude<ProviderSelectionResult, { kind: 'selected' }>;
  target: ReferenceTarget;
  targetProjects: SourceProject[];
}): void {
  if (options.selection.kind === 'missing') {
    options.base.context.problems.push(
      formatMissingCrossCheckerProviderProblem({
        config: options.base.context.config,
        importRecord: options.base.importRecord,
        project: options.base.project,
        resolvedFilePath: options.target.resolvedFilePath,
        targetProjects: options.targetProjects,
        targetSourceConfigPath: options.target.targetSourceConfigPath,
      }),
    );
    return;
  }
  const formatter =
    options.selection.kind === 'ambiguous'
      ? formatAmbiguousCrossCheckerProviderProblem
      : formatUnsafeCrossEngineProviderProblem;
  options.base.context.problems.push(
    formatter({
      candidates: options.selection.candidates,
      config: options.base.context.config,
      importRecord: options.base.importRecord,
      project: options.base.project,
      resolvedFilePath: options.target.resolvedFilePath,
      targetSourceConfigPath: options.target.targetSourceConfigPath,
    }),
  );
}

function createProviderEdge(options: {
  base: ReferenceImportOptions;
  providerProject: SourceProject;
  target: ReferenceTarget;
}): GeneratedProviderEdge {
  return {
    file: formatImportRecordLocation(
      options.base.context.config.rootDir,
      options.base.importRecord,
    ),
    fromChecker: options.base.project.checkerName,
    fromConfigPath: options.base.project.configPath,
    importedSpecifier: options.base.importRecord.specifier,
    resolvedFilePath: options.target.resolvedFilePath,
    toChecker: options.providerProject.checkerName,
    toConfigPath: options.target.targetSourceConfigPath,
  };
}

function createProviderEdgeKey(edge: GeneratedProviderEdge): string {
  return JSON.stringify([
    edge.fromChecker,
    edge.fromConfigPath,
    edge.toChecker,
    edge.toConfigPath,
    edge.file,
    edge.importedSpecifier,
    edge.resolvedFilePath,
  ]);
}

function isTargetDenied(options: {
  base: ReferenceImportOptions;
  target: ReferenceTarget;
}): boolean {
  return isDeniedGeneratedReference({
    config: options.base.context.config,
    project: options.base.project,
    targetSourceConfigPath: options.target.targetSourceConfigPath,
  });
}

function addSelectedProviderReference(options: {
  base: ReferenceImportOptions;
  providerProject: SourceProject;
  target: ReferenceTarget;
}): void {
  if (isTargetDenied(options)) {
    return;
  }
  const edge = createProviderEdge(options);
  options.base.context.providerEdgesByKey.set(
    createProviderEdgeKey(edge),
    edge,
  );
  options.base.project.references.add(options.providerProject.dtsConfigPath);
}

function formatUnmappedImport(options: {
  base: ReferenceImportOptions;
  target: ReferenceTarget;
}): string {
  return [
    'Unable to map generated graph import to a declaration project:',
    `  importing config: ${toRelativePath(options.base.context.config.rootDir, options.base.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.base.context.config.rootDir, options.base.importRecord)}`,
    `  imported specifier: ${options.base.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.base.context.config.rootDir, options.target.resolvedFilePath)}`,
  ].join('\n');
}

function getOtherCheckerProjects(options: {
  base: ReferenceImportOptions;
  target: ReferenceTarget;
}): SourceProject[] {
  return getDtsProjectsForSourcePath({
    dtsProjectsBySourcePath: options.base.context.dtsProjectsBySourcePath,
    sourceConfigPath: options.target.targetSourceConfigPath,
  }).filter(
    (targetProject) =>
      targetProject.checkerName !== options.base.project.checkerName,
  );
}

function addCrossCheckerReference(options: {
  base: ReferenceImportOptions;
  target: ReferenceTarget;
}): void {
  const targetProjects = getOtherCheckerProjects(options);
  if (targetProjects.length === 0) {
    options.base.context.problems.push(formatUnmappedImport(options));
    return;
  }
  const selection = selectProviderProject({
    consumerProject: options.base.project,
    providerSourceFilePath: options.target.providerSourceFilePath,
    targetProjects,
  });
  if (selection.kind !== 'selected') {
    addSelectionProblem({ ...options, selection, targetProjects });
    return;
  }
  addSelectedProviderReference({
    ...options,
    providerProject: selection.project,
  });
}

export function addMappedReference(options: {
  base: ReferenceImportOptions;
  target: ReferenceTarget;
}): void {
  const targetDtsConfigPath = getDtsConfigPathForSourcePath({
    checkerName: options.base.project.checkerName,
    dtsProjectsBySourcePath: options.base.context.dtsProjectsBySourcePath,
    sourceConfigPath: options.target.targetSourceConfigPath,
  });
  if (!targetDtsConfigPath) {
    addCrossCheckerReference(options);
    return;
  }
  if (isTargetDenied(options)) {
    return;
  }
  options.base.project.references.add(targetDtsConfigPath);
}
