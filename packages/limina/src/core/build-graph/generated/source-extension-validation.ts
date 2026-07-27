import {
  type CheckerProjectParseContext,
  parseCheckerProjectConfigForContext,
} from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import {
  capabilityDiscoveryExtensions,
  getFileExtension,
} from './file-extensions';

export interface SourceProjectLike {
  checkerName: string;
  configPath: string;
  context: CheckerProjectParseContext;
  fileNames: string[];
}

const checkerPresetSuggestionsByExtension = new Map<string, string[]>([
  ['.svelte', ['svelte-check']],
  ['.vue', ['vue-tsc']],
]);

function createProjectsBySourcePath(
  projects: readonly SourceProjectLike[],
): Map<string, SourceProjectLike[]> {
  const projectsBySourcePath = new Map<string, SourceProjectLike[]>();

  for (const project of projects) {
    const projectsForPath = getProjectsForPath(
      projectsBySourcePath,
      project.configPath,
    );
    projectsBySourcePath.set(project.configPath, [...projectsForPath, project]);
  }

  return projectsBySourcePath;
}

function getProjectsForPath(
  projectsBySourcePath: ReadonlyMap<string, SourceProjectLike[]>,
  configPath: string,
): SourceProjectLike[] {
  return projectsBySourcePath.get(configPath) ?? [];
}

function collectSupportedExtensions(
  projects: readonly SourceProjectLike[],
): Set<string> {
  return new Set(
    projects.flatMap((project) => [
      ...project.context.extensions,
      ...project.fileNames.map(getFileExtension).filter(Boolean),
    ]),
  );
}

function isUnsupportedExtension(
  extension: string,
  supportedExtensions: ReadonlySet<string>,
): boolean {
  return extension.length > 0 && !supportedExtensions.has(extension);
}

function getFilesForExtension(
  filesByExtension: ReadonlyMap<string, string[]>,
  extension: string,
): string[] {
  return filesByExtension.get(extension) ?? [];
}

function addUnsupportedFile(options: {
  fileName: string;
  supportedExtensions: ReadonlySet<string>;
  unsupportedFilesByExtension: Map<string, string[]>;
}): void {
  const extension = getFileExtension(options.fileName);

  if (!isUnsupportedExtension(extension, options.supportedExtensions)) {
    return;
  }

  const files = getFilesForExtension(
    options.unsupportedFilesByExtension,
    extension,
  );
  options.unsupportedFilesByExtension.set(extension, [
    ...files,
    options.fileName,
  ]);
}

function collectUnsupportedFiles(options: {
  config: ResolvedLiminaConfig;
  projects: readonly SourceProjectLike[];
  sourceConfigPath: string;
}): Map<string, string[]> {
  const neutralContext: CheckerProjectParseContext = {
    checkerPresets: ['tsc'],
    extensions: capabilityDiscoveryExtensions,
  };
  const neutralParsed = parseCheckerProjectConfigForContext({
    configPath: options.sourceConfigPath,
    context: neutralContext,
    projectRootDir: options.config.rootDir,
  });
  const supportedExtensions = collectSupportedExtensions(options.projects);
  const unsupportedFilesByExtension = new Map<string, string[]>();

  for (const fileName of neutralParsed.fileNames.map(normalizeAbsolutePath)) {
    addUnsupportedFile({
      fileName,
      supportedExtensions,
      unsupportedFilesByExtension,
    });
  }

  return unsupportedFilesByExtension;
}

function getCheckerPresetLabel(project: SourceProjectLike): string {
  const preset = project.context.checkerPresets[0] ?? 'unknown';
  return `${project.checkerName} (${preset})`;
}

function getCheckerPresetSuggestion(extension: string): string {
  return (
    checkerPresetSuggestionsByExtension.get(extension)?.join(', ') ??
    'a checker preset that supports this extension'
  );
}

function formatExtensionLines(
  config: ResolvedLiminaConfig,
  fileNamesByExtension: ReadonlyMap<string, string[]>,
): string[] {
  return [...fileNamesByExtension.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([extension, fileNames]) => [
      `  - extension: ${extension}`,
      `    example: ${toRelativePath(config.rootDir, fileNames[0]!)}`,
      `    suggested checker: ${getCheckerPresetSuggestion(extension)}`,
    ]);
}

function formatUnsupportedSourceConfigProblem(options: {
  config: ResolvedLiminaConfig;
  fileNamesByExtension: ReadonlyMap<string, string[]>;
  projects: readonly SourceProjectLike[];
  sourceConfigPath: string;
}): string {
  const checkerLabels = options.projects
    .map(getCheckerPresetLabel)
    .sort((left, right) => left.localeCompare(right));

  return [
    'Source config contains files unsupported by its checker coverage:',
    `  config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
    `  checkers: ${checkerLabels.join(', ')}`,
    '  unsupported files:',
    ...formatExtensionLines(options.config, options.fileNamesByExtension),
    '  reason: every file reached by an effective source config must be supported by at least one checker preset that covers that config.',
    '  fix: add a checker with a matching capability through another tsconfig.json entry that references this source config, or move the files to a config covered by that checker.',
  ].join('\n');
}

function addUnsupportedSourceConfigProblem(options: {
  config: ResolvedLiminaConfig;
  problems: string[];
  projects: readonly SourceProjectLike[];
  sourceConfigPath: string;
}): void {
  const unsupportedFiles = collectUnsupportedFiles(options);

  if (unsupportedFiles.size > 0) {
    options.problems.push(
      formatUnsupportedSourceConfigProblem({
        ...options,
        fileNamesByExtension: unsupportedFiles,
      }),
    );
  }
}

export function addUnsupportedSourceConfigExtensionProblems(options: {
  config: ResolvedLiminaConfig;
  problems: string[];
  projects: SourceProjectLike[];
}): void {
  const projectsBySourcePath = createProjectsBySourcePath(options.projects);

  for (const [sourceConfigPath, projects] of projectsBySourcePath) {
    addUnsupportedSourceConfigProblem({
      config: options.config,
      problems: options.problems,
      projects,
      sourceConfigPath,
    });
  }
}
