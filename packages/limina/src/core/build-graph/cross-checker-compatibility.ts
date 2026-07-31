import { getBuildCheckerSupportedExtensions } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import { getFileExtension } from './generated/file-extensions';
import type { GeneratedProviderEdge, SourceProject } from './types';

interface UnsupportedCrossCheckerProviderFile {
  extension: string;
  fileName: string;
  generatedConfigPath: string;
  sourceConfigPath: string;
}

export function createSourceProjectKey(
  checkerName: string,
  configPath: string,
): string {
  return JSON.stringify([checkerName, configPath]);
}

function getUnseenReferenceProject(options: {
  projectByDtsConfigPath: ReadonlyMap<string, SourceProject>;
  referencePath: string;
  seen: ReadonlySet<string>;
}): SourceProject | null {
  const referenceProject = options.projectByDtsConfigPath.get(
    options.referencePath,
  );
  if (!referenceProject) {
    return null;
  }
  return options.seen.has(referenceProject.dtsConfigPath)
    ? null
    : referenceProject;
}

function enqueueProjectReferences(options: {
  project: SourceProject;
  projectByDtsConfigPath: ReadonlyMap<string, SourceProject>;
  queue: SourceProject[];
  seen: ReadonlySet<string>;
}): void {
  for (const referencePath of options.project.references) {
    const referenceProject = getUnseenReferenceProject({
      projectByDtsConfigPath: options.projectByDtsConfigPath,
      referencePath,
      seen: options.seen,
    });
    if (referenceProject) {
      options.queue.push(referenceProject);
    }
  }
}

function collectGeneratedDtsProjectClosure(options: {
  projectByDtsConfigPath: Map<string, SourceProject>;
  rootProject: SourceProject;
}): SourceProject[] {
  const closure: SourceProject[] = [];
  const seen = new Set<string>();
  const queue = [options.rootProject];
  while (queue.length > 0) {
    const project = queue.shift()!;
    if (seen.has(project.dtsConfigPath)) {
      continue;
    }
    seen.add(project.dtsConfigPath);
    closure.push(project);
    enqueueProjectReferences({
      project,
      projectByDtsConfigPath: options.projectByDtsConfigPath,
      queue,
      seen,
    });
  }
  return closure;
}

function getConsumerSupportedExtensions(project: SourceProject): Set<string> {
  const consumerPreset = project.context.checkerPresets[0];
  if (!consumerPreset) {
    return new Set(project.context.extensions);
  }
  return new Set([
    ...getBuildCheckerSupportedExtensions(consumerPreset),
    ...project.context.extensions,
  ]);
}

function createUnsupportedFile(options: {
  fileName: string;
  project: SourceProject;
  supportedExtensions: ReadonlySet<string>;
}): UnsupportedCrossCheckerProviderFile | null {
  const extension = getFileExtension(options.fileName);
  if (!extension) {
    return null;
  }
  if (options.supportedExtensions.has(extension)) {
    return null;
  }
  return {
    extension,
    fileName: options.fileName,
    generatedConfigPath: options.project.dtsConfigPath,
    sourceConfigPath: options.project.configPath,
  };
}

function collectProjectUnsupportedFiles(options: {
  project: SourceProject;
  supportedExtensions: ReadonlySet<string>;
}): UnsupportedCrossCheckerProviderFile[] {
  return options.project.fileNames
    .map((fileName) => createUnsupportedFile({ ...options, fileName }))
    .filter((file): file is UnsupportedCrossCheckerProviderFile =>
      Boolean(file),
    );
}

function sortUnsupportedFiles(
  files: UnsupportedCrossCheckerProviderFile[],
): UnsupportedCrossCheckerProviderFile[] {
  return files.sort(
    (left, right) =>
      compareCodeUnits(left.generatedConfigPath, right.generatedConfigPath) ||
      compareCodeUnits(left.extension, right.extension) ||
      compareCodeUnits(left.fileName, right.fileName),
  );
}

function collectUnsupportedCrossCheckerProviderFiles(options: {
  consumerProject: SourceProject;
  projectByDtsConfigPath: Map<string, SourceProject>;
  providerProject: SourceProject;
}): UnsupportedCrossCheckerProviderFile[] {
  const supportedExtensions = getConsumerSupportedExtensions(
    options.consumerProject,
  );
  const closure = collectGeneratedDtsProjectClosure({
    projectByDtsConfigPath: options.projectByDtsConfigPath,
    rootProject: options.providerProject,
  });
  const unsupportedFiles = closure.flatMap((project) =>
    collectProjectUnsupportedFiles({ project, supportedExtensions }),
  );
  return sortUnsupportedFiles(unsupportedFiles);
}

function formatUnsupportedCrossCheckerProviderProblem(options: {
  config: ResolvedLiminaConfig;
  consumerProject: SourceProject;
  edge: GeneratedProviderEdge;
  providerProject: SourceProject;
  unsupportedFiles: UnsupportedCrossCheckerProviderFile[];
}): string {
  const consumerPreset =
    options.consumerProject.context.checkerPresets[0] ?? 'unknown';
  const providerPreset =
    options.providerProject.context.checkerPresets[0] ?? 'unknown';
  const unsupportedLines = options.unsupportedFiles.map((file) => [
    `  - generated config: ${toRelativePath(options.config.rootDir, file.generatedConfigPath)}`,
    `    source config: ${toRelativePath(options.config.rootDir, file.sourceConfigPath)}`,
    `    extension: ${file.extension}`,
    `    example: ${toRelativePath(options.config.rootDir, file.fileName)}`,
  ]);
  return [
    'Unsupported cross-checker declaration provider:',
    `  consumer checker: ${options.consumerProject.checkerName} (${consumerPreset})`,
    `  consumer config: ${toRelativePath(options.config.rootDir, options.consumerProject.configPath)}`,
    `  provider checker: ${options.providerProject.checkerName} (${providerPreset})`,
    `  provider config: ${toRelativePath(options.config.rootDir, options.providerProject.configPath)}`,
    `  file: ${options.edge.file}`,
    `  imported specifier: ${options.edge.importedSpecifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.edge.resolvedFilePath)}`,
    '  unsupported provider files:',
    ...unsupportedLines.flat(),
    '  reason: cross-checker provider references must be buildable by the consumer checker across the entire generated declaration reference tree.',
    '  fix: cover the target source config with the consumer checker, or expose a TypeScript-only boundary that the consumer checker can build.',
  ].join('\n');
}

function getProviderProjectPair(options: {
  edge: GeneratedProviderEdge;
  projectBySourceKey: Map<string, SourceProject>;
}): { consumerProject: SourceProject; providerProject: SourceProject } | null {
  const consumerProject = options.projectBySourceKey.get(
    createSourceProjectKey(
      options.edge.fromChecker,
      options.edge.fromConfigPath,
    ),
  );
  const providerProject = options.projectBySourceKey.get(
    createSourceProjectKey(options.edge.toChecker, options.edge.toConfigPath),
  );
  if (!consumerProject || !providerProject) {
    return null;
  }
  return { consumerProject, providerProject };
}

function addProviderEdgeCompatibilityProblem(options: {
  config: ResolvedLiminaConfig;
  edge: GeneratedProviderEdge;
  problems: string[];
  projectByDtsConfigPath: Map<string, SourceProject>;
  projectBySourceKey: Map<string, SourceProject>;
}): void {
  const pair = getProviderProjectPair(options);
  if (!pair) {
    return;
  }
  const { consumerProject, providerProject } = pair;
  const unsupportedFiles = collectUnsupportedCrossCheckerProviderFiles({
    consumerProject,
    projectByDtsConfigPath: options.projectByDtsConfigPath,
    providerProject,
  });
  if (unsupportedFiles.length === 0) {
    return;
  }
  options.problems.push(
    formatUnsupportedCrossCheckerProviderProblem({
      config: options.config,
      consumerProject,
      edge: options.edge,
      providerProject,
      unsupportedFiles,
    }),
  );
}

export function addCrossCheckerProviderCompatibilityProblems(options: {
  config: ResolvedLiminaConfig;
  problems: string[];
  projects: SourceProject[];
  providerEdges: GeneratedProviderEdge[];
}): void {
  const projectBySourceKey = new Map(
    options.projects.map((project) => [
      createSourceProjectKey(project.checkerName, project.configPath),
      project,
    ]),
  );
  const projectByDtsConfigPath = new Map(
    options.projects.map((project) => [project.dtsConfigPath, project]),
  );
  for (const edge of options.providerEdges) {
    addProviderEdgeCompatibilityProblem({
      config: options.config,
      edge,
      problems: options.problems,
      projectByDtsConfigPath,
      projectBySourceKey,
    });
  }
}
