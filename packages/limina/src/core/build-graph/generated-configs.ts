import { isBuildCapablePreset } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import { createLiminaTsconfigSchemaPath } from '#core/tsconfig/actions';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { createGeneratedCompilerOptionOverrides } from './compiler-overrides';
import { readGraphRules } from './generated/config-readers';
import {
  createRelativePath,
  getGeneratedOutDir as getGeneratedOutDirectory,
  getGeneratedOutputTsBuildInfoPath,
  getGeneratedTsBuildInfoPath,
} from './generated/paths';
import { getCommonSourceRootDirectory } from './generated/source-root';
import { proveTypeInputProjection } from './type-input-projection';
import type {
  OutputSolutionProject,
  SolutionProject,
  SourceProject,
} from './types';

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
    ? {
        // Rewriting implicitly permits TS extensions, even with explicit allow=false.
        allowImportingTsExtensions: true,
        rewriteRelativeImportExtensions: false,
      }
    : {};
}

export function createGeneratedDtsConfig(options: {
  cache?: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
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
  const result = {
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
        cache: options.cache,
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
  (project.typeInputProjections ??= []).push(
    proveTypeInputProjection(project, project.dtsConfigPath, {
      overrides: result.compilerOptions,
      cache: options.cache,
    }),
  );
  return result;
}

function requireOutputOptions(options: {
  config: ResolvedLiminaInputs;
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
  cache?: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  project: SourceProject;
}): Record<string, unknown> {
  const { config, project } = options;
  const outputOptions = requireOutputOptions(options);
  const result = {
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
        cache: options.cache,
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
  (project.typeInputProjections ??= []).push(
    proveTypeInputProjection(project, project.outputConfigPath, {
      overrides: result.compilerOptions,
      cache: options.cache,
    }),
  );
  return result;
}

function createGeneratedSolutionConfig(options: {
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
  solution: SolutionProject;
}): Record<string, unknown> {
  return createGeneratedSolutionConfig(options);
}

export function createGeneratedOutputSolutionConfig(options: {
  config: ResolvedLiminaInputs;
  solution: OutputSolutionProject;
}): Record<string, unknown> {
  return createGeneratedSolutionConfig(options);
}

export { createCheckerBuildConfig } from './checker-build-config';
