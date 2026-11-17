import { isBuildCapablePreset } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toRelativePath,
} from '#utils/path';
import { getEffectiveImporterRoots } from '../typescript-semantic/effective-roots';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { readGraphRules, readOutputOptions } from './generated/config-readers';
import {
  getGeneratedDtsConfigPath,
  getGeneratedOutputProjectConfigPath,
  getGeneratedSolutionBuildConfigPath,
} from './generated/paths';
import type { FrozenSemanticProject } from './locked-semantic-project';
import type {
  CheckerSourceConfigCollection,
  SolutionProject,
  SourceProject,
} from './types';

export function isInsideNodeModules(filePath: string): boolean {
  return normalizeAbsolutePath(filePath).split('/').includes('node_modules');
}

export function createSourceProject(options: {
  checkerName: SourceProject['checkerName'];
  config: ResolvedLiminaInputs;
  frozen: FrozenSemanticProject;
  packageRootDir: string;
}): SourceProject {
  const parsed = options.frozen.project;
  const sourceConfigPath = parsed.configPath;
  if (
    isBuildCapablePreset(options.checkerName) &&
    parsed.options.outFile !== undefined
  ) {
    throw new Error(
      [
        'outFile is not supported in generated projects:',
        `  config: ${toRelativePath(options.config.rootDir, sourceConfigPath)}`,
        '  reason: bundled output cannot preserve the managed per-file declaration mapping.',
        '  Remove outFile from the source configuration before generating the Reference Graph.',
      ].join('\n'),
    );
  }
  const ownedFileNames = parsed.fileNames
    .map(normalizeAbsolutePath)
    .filter((fileName) => !isInsideNodeModules(fileName))
    .sort(compareCodeUnits);
  const outputOptions = readOutputOptions(options.config, sourceConfigPath);

  return {
    checkerName: options.checkerName,
    configClosure: parsed.configClosure.map((entry) => ({ ...entry })),
    configPath: sourceConfigPath,
    context: {
      ...parsed.context,
      checkerPresets: [...parsed.context.checkerPresets],
      extensions: [...parsed.context.extensions],
    },
    dtsConfigPath: getGeneratedDtsConfigPath({
      checkerName: options.checkerName,
      packageRootDir: options.packageRootDir,
      rootDir: options.config.rootDir,
      sourceConfigPath,
    }),
    fileNames: getEffectiveImporterRoots({
      configPath: sourceConfigPath,
      fileNames: ownedFileNames,
      options: parsed.options,
    }),
    graphRules: readGraphRules(options.config, sourceConfigPath),
    ownedFileNames,
    outputConfigPath: getGeneratedOutputProjectConfigPath({
      checkerName: options.checkerName,
      packageRootDir: options.packageRootDir,
      rootDir: options.config.rootDir,
      sourceConfigPath,
    }),
    outputOptions: outputOptions.outputs,
    outputReferences: new Set(),
    packageRootDir: options.packageRootDir,
    options: parsed.options,
    virtualFiles: options.config.virtualFiles,
    references: new Set(),
    semanticAuthority: { ...options.frozen.authority },
  };
}

export function isLocalPathOutsideActivatedRegions(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaInputs;
  filePath: string;
}): boolean {
  const filePath = normalizeAbsolutePath(options.filePath);
  return (
    isPathInsideDirectory(filePath, options.config.rootDir) &&
    !isInsideNodeModules(filePath) &&
    !options.activatedRegions.isInsideActivatedRegion(filePath)
  );
}

function getOutOfRegionOwnedFiles(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  project: SourceProject;
}): string[] {
  return options.project.ownedFileNames.filter((fileName) => {
    return (
      isInsideNodeModules(fileName) ||
      !options.activatedRegions.isInsideActivatedRegion(fileName)
    );
  });
}

function addOwnedRegionProblem(options: {
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
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
