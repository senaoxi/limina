import { isBuildCapablePreset } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toRelativePath,
} from '#utils/path';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { getSvelteSourceConfigReader } from '../svelte-semantic/project';
import { getEffectiveImporterRoots } from '../typescript-semantic/effective-roots';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { readGraphRules, readOutputOptions } from './generated/config-readers';
import {
  getGeneratedDtsConfigPath,
  getGeneratedOutputProjectConfigPath,
  getGeneratedSolutionBuildConfigPath,
} from './generated/paths';
import type { FrozenSemanticProject } from './locked-semantic-project';
import { sourcePackageScopeProblems } from './source-package-scope';
import { sourceTypeInputs } from './type-input-projection';
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
    configClosure: [...parsed.configClosure],
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
    sourceConfigReferences: parsed.references,
    readSvelteSourceConfig:
      options.frozen.authority.family === 'svelte'
        ? getSvelteSourceConfigReader(parsed)
        : undefined,
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

function getOutOfRegionTypeInputs(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  cache?: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  project: SourceProject;
}): string[] {
  return sourceTypeInputs(options.project, options.cache).flatMap((entry) => {
    if (entry.target === null) return [];
    const isOutside =
      options.activatedRegions.findBoundaryForPath(entry.target) !== null ||
      isLocalPathOutsideActivatedRegions({
        ...options,
        filePath: entry.target,
      });
    return isOutside ? [entry.target] : [];
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
  cache?: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  problems: string[];
  project: SourceProject;
}): void {
  options.problems.push(
    ...sourcePackageScopeProblems(
      options.config,
      options.activatedRegions,
      options.project.configPath,
      options.project.ownedFileNames,
    ),
  );
  addLocalRegionProblem({
    ...options,
    files: getOutOfRegionTypeInputs(options),
  });
}

export function addActivatedRegionSourceProjectProblems(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  cache?: NativeAnalysisCache;
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
