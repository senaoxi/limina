import type { ResolvedLiminaConfig } from '#config/runner';
import { createLiminaTsconfigSchemaPath } from '#core/tsconfig/actions';
import { toRelativePath } from '#utils/path';
import path from 'pathe';
import { createGeneratedCompilerOptionOverrides } from './compiler-overrides';
import {
  createRelativePath,
  getGeneratedOutDir,
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
  if (relativePath === '') {
    return true;
  }
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function containsAllDirectories(
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
  while (!containsAllDirectories(commonDirectory, fileDirectories)) {
    const parentDirectory = path.dirname(commonDirectory);
    if (parentDirectory === commonDirectory) {
      return commonDirectory;
    }
    commonDirectory = parentDirectory;
  }
  return commonDirectory;
}

function getCommonSourceRootDir(project: SourceProject): string {
  const fileDirectories = project.fileNames.map((fileName) =>
    path.dirname(fileName),
  );
  if (fileDirectories.length === 0) {
    return path.dirname(project.configPath);
  }
  return findCommonDirectory(fileDirectories[0]!, fileDirectories);
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

export function createGeneratedDtsConfig(options: {
  config: ResolvedLiminaConfig;
  project: SourceProject;
}): Record<string, unknown> {
  const { config, project } = options;
  const managedOutDir = getGeneratedOutDir({
    checkerName: project.checkerName,
    packageRootDir: project.packageRootDir,
    rootDir: config.rootDir,
    sourceConfigPath: project.configPath,
  });
  const relativeManagedOutDir = createRelativePath(
    project.dtsConfigPath,
    managedOutDir,
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
      ...createGeneratedCompilerOptionOverrides({ config, project }),
      composite: true,
      incremental: true,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      declarationMap: false,
      rewriteRelativeImportExtensions: false,
      rootDir: createRelativePath(
        project.dtsConfigPath,
        getCommonSourceRootDir(project),
      ),
      outDir: relativeManagedOutDir,
      declarationDir: relativeManagedOutDir,
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
    references: [...project.references].sort().map((referencePath) => ({
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
    references: [...project.outputReferences].sort().map((referencePath) => ({
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
  return {
    $schema: createLiminaTsconfigSchemaPath(
      options.config.rootDir,
      options.solution.buildConfigPath,
    ),
    files: [],
    references: [...options.solution.references]
      .sort()
      .map((referencePath) => ({
        path: createRelativePath(
          options.solution.buildConfigPath,
          referencePath,
        ),
      })),
    liminaOptions: {
      generated: true,
      checker: options.solution.checkerName,
      sourceConfig: createRelativePath(
        options.solution.buildConfigPath,
        options.solution.configPath,
      ),
    },
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

export function createCheckerBuildConfig(options: {
  checkerName: string;
  entryPath: string;
  references: string[];
  rootDir: string;
}): Record<string, unknown> {
  return {
    $schema: createLiminaTsconfigSchemaPath(options.rootDir, options.entryPath),
    files: [],
    references: options.references.sort().map((referencePath) => ({
      path: createRelativePath(options.entryPath, referencePath),
    })),
    liminaOptions: { generated: true, checker: options.checkerName },
  };
}
