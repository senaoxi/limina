import { isBuildCapablePreset } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { createLiminaTsconfigSchemaPath } from '#core/tsconfig/actions';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import path from 'pathe';
import { createGeneratedCompilerOptionOverrides } from './compiler-overrides';
import { readGraphRules } from './generated/config-readers';
import {
  createRelativePath,
  getGeneratedOutDir as getGeneratedOutDirectory,
  getGeneratedOutputTsBuildInfoPath,
  getGeneratedTsBuildInfoPath,
} from './generated/paths';
import type {
  OutputSolutionProject,
  SolutionProject,
  SourceProject,
} from './types';

function isSameOrParentDirectory(
  parentDirectory: string,
  childDirectory: string,
): boolean {
  const relativePath = path.relative(parentDirectory, childDirectory);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function isContainsAllDirectories(
  parentDirectory: string,
  childDirectories: string[],
): boolean {
  return childDirectories.every((childDirectory) =>
    isSameOrParentDirectory(parentDirectory, childDirectory),
  );
}

function findCommonDirectory(
  initialDirectory: string,
  fileDirectories: string[],
): string {
  let commonDirectory = initialDirectory;
  while (!isContainsAllDirectories(commonDirectory, fileDirectories)) {
    const parentDirectory = path.dirname(commonDirectory);
    if (parentDirectory === commonDirectory) {
      return commonDirectory;
    }
    commonDirectory = parentDirectory;
  }
  return commonDirectory;
}

function getCommonSourceRootDirectory(project: SourceProject): string {
  const fileDirectories = project.fileNames.map((fileName) =>
    path.dirname(fileName),
  );
  return fileDirectories.length === 0
    ? path.dirname(project.configPath)
    : findCommonDirectory(fileDirectories[0]!, fileDirectories);
}

function assertDeclarationInputFiles(project: SourceProject): void {
  if (!isBuildCapablePreset(project.context.checkerPresets[0]!)) return;
  const frameworkFile = project.fileNames.find(
    (fileName) => fileName.endsWith('.astro') || fileName.endsWith('.svelte'),
  );
  if (frameworkFile === undefined) return;
  throw new Error(
    `Generated declaration project cannot include framework source: ${frameworkFile}`,
  );
}

function createDtsLiminaOptions(
  project: SourceProject,
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    generated: true,
    checker: project.checkerName,
    sourceConfig: createRelativePath(project.dtsConfigPath, project.configPath),
  };
  if (project.graphRules.length > 0) {
    options.graphRules = project.graphRules;
  }
  return options;
}

function createRelativeImportRewriteOverride(
  project: SourceProject,
): Record<string, unknown> {
  return project.options.rewriteRelativeImportExtensions === true
    ? { rewriteRelativeImportExtensions: false }
    : {};
}

export function createGeneratedDtsConfig(options: {
  config: ResolvedLiminaConfig;
  project: SourceProject;
}): Record<string, unknown> {
  const { config, project } = options;
  assertDeclarationInputFiles(project);
  const managedOutDirectory = getGeneratedOutDirectory({
    checkerName: project.checkerName,
    packageRootDir: project.packageRootDir,
    rootDir: config.rootDir,
    sourceConfigPath: project.configPath,
  });
  const relativeManagedOutDirectory = createRelativePath(
    project.dtsConfigPath,
    managedOutDirectory,
  );
  return {
    $schema: createLiminaTsconfigSchemaPath(
      config.rootDir,
      project.dtsConfigPath,
    ),
    extends: [createRelativePath(project.dtsConfigPath, project.configPath)],
    files: project.fileNames.map((fileName) =>
      createRelativePath(project.dtsConfigPath, fileName),
    ),
    include: [],
    compilerOptions: {
      ...createGeneratedCompilerOptionOverrides({
        config,
        project,
        generatedConfigPath: project.dtsConfigPath,
      }),
      composite: true,
      incremental: true,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      declarationMap: false,
      ...createRelativeImportRewriteOverride(project),
      rootDir: createRelativePath(
        project.dtsConfigPath,
        getCommonSourceRootDirectory(project),
      ),
      outDir: relativeManagedOutDirectory,
      declarationDir: relativeManagedOutDirectory,
      tsBuildInfoFile: createRelativePath(
        project.dtsConfigPath,
        getGeneratedTsBuildInfoPath({
          checkerName: project.checkerName,
          packageRootDir: project.packageRootDir,
          rootDir: config.rootDir,
          sourceConfigPath: project.configPath,
        }),
      ),
    },
    references: [...project.references]
      .sort(compareCodeUnits)
      .map((referencePath) => ({
        path: createRelativePath(project.dtsConfigPath, referencePath),
      })),
    liminaOptions: createDtsLiminaOptions(project),
  };
}

function requireOutputOptions(options: {
  config: ResolvedLiminaConfig;
  project: SourceProject;
}): NonNullable<SourceProject['outputOptions']> {
  if (options.project.outputOptions) {
    return options.project.outputOptions;
  }
  throw new Error(
    `Missing output options for ${toRelativePath(options.config.rootDir, options.project.configPath)}.`,
  );
}

export function createGeneratedOutputProjectConfig(options: {
  config: ResolvedLiminaConfig;
  project: SourceProject;
}): Record<string, unknown> {
  const { config, project } = options;
  const outputOptions = requireOutputOptions(options);
  return {
    $schema: createLiminaTsconfigSchemaPath(
      config.rootDir,
      project.outputConfigPath,
    ),
    extends: [createRelativePath(project.outputConfigPath, project.configPath)],
    files: project.fileNames.map((fileName) =>
      createRelativePath(project.outputConfigPath, fileName),
    ),
    include: [],
    compilerOptions: {
      ...createGeneratedCompilerOptionOverrides({
        config,
        project,
        generatedConfigPath: project.outputConfigPath,
      }),
      composite: true,
      incremental: true,
      noEmit: false,
      declaration: true,
      declarationMap: outputOptions.declarationMap,
      emitDeclarationOnly: false,
      target: outputOptions.target,
      rootDir: createRelativePath(
        project.outputConfigPath,
        outputOptions.rootDir,
      ),
      outDir: createRelativePath(
        project.outputConfigPath,
        outputOptions.outDir,
      ),
      declarationDir: createRelativePath(
        project.outputConfigPath,
        outputOptions.outDir,
      ),
      tsBuildInfoFile: createRelativePath(
        project.outputConfigPath,
        getGeneratedOutputTsBuildInfoPath({
          packageRootDir: project.packageRootDir,
          rootDir: config.rootDir,
          sourceConfigPath: project.configPath,
        }),
      ),
    },
    references: [...project.outputReferences]
      .sort(compareCodeUnits)
      .map((referencePath) => ({
        path: createRelativePath(project.outputConfigPath, referencePath),
      })),
    liminaOptions: {
      generated: true,
      checker: project.checkerName,
      sourceConfig: createRelativePath(
        project.outputConfigPath,
        project.configPath,
      ),
    },
  };
}

function createGeneratedSolutionConfig(options: {
  config: ResolvedLiminaConfig;
  solution: SolutionProject | OutputSolutionProject;
}): Record<string, unknown> {
  const liminaOptions: Record<string, unknown> = {
    generated: true,
    checker: options.solution.checkerName,
    sourceConfig: createRelativePath(
      options.solution.buildConfigPath,
      options.solution.configPath,
    ),
  };
  const graphRules = readGraphRules(
    options.config,
    options.solution.configPath,
  );
  if (graphRules.length > 0) liminaOptions.graphRules = graphRules;
  return {
    $schema: createLiminaTsconfigSchemaPath(
      options.config.rootDir,
      options.solution.buildConfigPath,
    ),
    files: [],
    references: [...options.solution.references]
      .sort(compareCodeUnits)
      .map((referencePath) => ({
        path: createRelativePath(
          options.solution.buildConfigPath,
          referencePath,
        ),
      })),
    liminaOptions,
  };
}

export function createGeneratedSolutionBuildConfig(options: {
  config: ResolvedLiminaConfig;
  solution: SolutionProject;
}): Record<string, unknown> {
  return createGeneratedSolutionConfig(options);
}

export function createGeneratedOutputSolutionConfig(options: {
  config: ResolvedLiminaConfig;
  solution: OutputSolutionProject;
}): Record<string, unknown> {
  return createGeneratedSolutionConfig(options);
}

export { createCheckerBuildConfig } from './checker-build-config';
