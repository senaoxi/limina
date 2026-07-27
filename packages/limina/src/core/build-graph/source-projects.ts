import {
  type CheckerProjectParseContext,
  parseCheckerProjectConfigForContext,
  resolveCheckerProjectExtensions,
} from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { uniqueSortedStrings } from '#utils/collections';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toRelativePath,
} from '#utils/path';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import {
  readGraphRules,
  readOutputOptions,
  readRelativeTypeFiles,
} from './generated/config-readers';
import {
  getGeneratedDtsConfigPath,
  getGeneratedOutputProjectConfigPath,
  getGeneratedSolutionBuildConfigPath,
} from './generated/paths';
import type {
  CheckerSourceConfigCollection,
  SolutionProject,
  SourceProject,
} from './types';

export function isInsideNodeModules(filePath: string): boolean {
  return normalizeAbsolutePath(filePath).split('/').includes('node_modules');
}

export function createSourceProject(options: {
  checkerName: string;
  checkerPreset: SourceProject['context']['checkerPresets'][number];
  config: ResolvedLiminaConfig;
  packageRootDir: string;
  sourceConfigPath: string;
}): SourceProject {
  const extensions = resolveCheckerProjectExtensions({
    configPath: options.sourceConfigPath,
    preset: options.checkerPreset,
    projectRootDir: options.config.rootDir,
  });
  const context: CheckerProjectParseContext = {
    checkerPresets: [options.checkerPreset],
    extensions,
  };
  const parsed = parseCheckerProjectConfigForContext({
    configPath: options.sourceConfigPath,
    context,
    projectRootDir: options.config.rootDir,
  });
  const ownedFileNames = parsed.fileNames
    .map(normalizeAbsolutePath)
    .filter((fileName) => !isInsideNodeModules(fileName))
    .sort();
  const outputOptions = readOutputOptions(
    options.config,
    options.sourceConfigPath,
  );

  return {
    checkerName: options.checkerName,
    configPath: options.sourceConfigPath,
    context,
    dtsConfigPath: getGeneratedDtsConfigPath({
      checkerName: options.checkerName,
      packageRootDir: options.packageRootDir,
      rootDir: options.config.rootDir,
      sourceConfigPath: options.sourceConfigPath,
    }),
    fileNames: uniqueSortedStrings([
      ...ownedFileNames,
      ...readRelativeTypeFiles(options.config, options.sourceConfigPath),
    ]),
    graphRules: readGraphRules(options.config, options.sourceConfigPath),
    ownedFileNames,
    outputConfigPath: getGeneratedOutputProjectConfigPath({
      checkerName: options.checkerName,
      packageRootDir: options.packageRootDir,
      rootDir: options.config.rootDir,
      sourceConfigPath: options.sourceConfigPath,
    }),
    outputOptions: outputOptions.outputs,
    outputReferences: new Set(),
    packageRootDir: options.packageRootDir,
    options: parsed.options,
    references: new Set(),
  };
}

export function isLocalPathOutsideActivatedRegions(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  filePath: string;
}): boolean {
  const filePath = normalizeAbsolutePath(options.filePath);
  if (!isPathInsideDirectory(filePath, options.config.rootDir)) {
    return false;
  }
  if (isInsideNodeModules(filePath)) {
    return false;
  }
  return !options.activatedRegions.isInsideActivatedRegion(filePath);
}

function getOutOfRegionOwnedFiles(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  project: SourceProject;
}): string[] {
  return options.project.ownedFileNames.filter((fileName) => {
    if (isInsideNodeModules(fileName)) {
      return true;
    }
    return !options.activatedRegions.isInsideActivatedRegion(fileName);
  });
}

function addOwnedRegionProblem(options: {
  config: ResolvedLiminaConfig;
  files: string[];
  problems: string[];
  project: SourceProject;
}): void {
  if (options.files.length === 0) {
    return;
  }
  options.problems.push(
    [
      'Source project owns files outside activated workspace package regions:',
      `  checker: ${options.project.checkerName}`,
      `  config: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
      ...options.files.map(
        (fileName) => `  - ${toRelativePath(options.config.rootDir, fileName)}`,
      ),
      '  reason: generated graph source ownership is bounded by current-run workspace packages.',
    ].join('\n'),
  );
}

function getOutOfRegionLocalFiles(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  project: SourceProject;
}): string[] {
  const ownedFileNames = new Set(options.project.ownedFileNames);
  return options.project.fileNames.filter((fileName) => {
    if (ownedFileNames.has(fileName)) {
      return false;
    }
    return isLocalPathOutsideActivatedRegions({
      ...options,
      filePath: fileName,
    });
  });
}

function addLocalRegionProblem(options: {
  config: ResolvedLiminaConfig;
  files: string[];
  problems: string[];
  project: SourceProject;
}): void {
  if (options.files.length === 0) {
    return;
  }
  options.problems.push(
    [
      'Source project includes local files outside activated workspace package regions:',
      `  checker: ${options.project.checkerName}`,
      `  config: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
      ...options.files.map(
        (fileName) => `  - ${toRelativePath(options.config.rootDir, fileName)}`,
      ),
      '  reason: local compiler inputs, including relative compilerOptions.types files, must stay inside current-run workspace packages.',
    ].join('\n'),
  );
}

function addProjectRegionProblems(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  problems: string[];
  project: SourceProject;
}): void {
  addOwnedRegionProblem({
    ...options,
    files: getOutOfRegionOwnedFiles(options),
  });
  addLocalRegionProblem({
    ...options,
    files: getOutOfRegionLocalFiles(options),
  });
}

export function addActivatedRegionSourceProjectProblems(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  problems: string[];
  projects: readonly SourceProject[];
}): void {
  for (const project of options.projects) {
    addProjectRegionProblems({ ...options, project });
  }
}

export function createSolutionProject(options: {
  checkerName: string;
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaConfig;
  packageRootDir: string;
  sourceConfigPath: string;
}): SolutionProject {
  const sourcePaths =
    options.collection.solutionReferencesBySourcePath.get(
      options.sourceConfigPath,
    ) ?? [];
  const references = sourcePaths
    .map((sourceConfigPath) =>
      options.collection.buildModulesBySourcePath.get(sourceConfigPath),
    )
    .filter((module) => Boolean(module))
    .map((module) => module!.path);
  return {
    buildConfigPath: getGeneratedSolutionBuildConfigPath({
      checkerName: options.checkerName,
      packageRootDir: options.packageRootDir,
      rootDir: options.config.rootDir,
      sourceConfigPath: options.sourceConfigPath,
    }),
    checkerName: options.checkerName,
    configPath: options.sourceConfigPath,
    packageRootDir: options.packageRootDir,
    references: new Set(references),
  };
}
