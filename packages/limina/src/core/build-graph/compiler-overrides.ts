import type { ResolvedLiminaInputs } from '#config/runner';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { absoluteCompilerPaths } from '../typescript-semantic/compiler-options';
import { collectTypeRootCandidates } from './generated/config-readers';
import { createRelativePath } from './generated/paths';
import { projectLibraryInputs } from './library-projection';
import { projectTypeDirectiveNames } from './type-input-projection';
import type { SourceProject } from './types';

function createGeneratedTypeRootOverrides(options: {
  config: ResolvedLiminaInputs;
  project: SourceProject;
  generatedConfigPath: string;
}): Record<string, unknown> {
  if (options.project.options.typeRoots !== undefined) {
    return {};
  }

  const typeRoots = collectTypeRootCandidates({
    rootDir: options.config.rootDir,
    sourceConfigPath: options.project.configPath,
  });
  if (typeRoots.length === 0) {
    return {};
  }

  return {
    typeRoots: typeRoots.map((typeRoot) =>
      createRelativePath(options.generatedConfigPath, typeRoot),
    ),
  };
}

export function createGeneratedCompilerOptionOverrides(options: {
  cache?: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  project: SourceProject;
  generatedConfigPath: string;
}): Record<string, unknown> {
  const source = options.project.options;
  const output: Record<string, unknown> = {
    ...createGeneratedTypeRootOverrides(options),
    ...(source.baseUrl !== undefined && { baseUrl: source.baseUrl }),
    ...(source.paths !== undefined && { paths: absoluteCompilerPaths(source) }),
    ...(source.rootDirs !== undefined && { rootDirs: source.rootDirs }),
    ...(source.typeRoots !== undefined && { typeRoots: source.typeRoots }),
  };
  const files = projectLibraryInputs(options);
  output.types = projectTypeDirectiveNames(
    options.project,
    options.generatedConfigPath,
    { overrides: output, cache: options.cache, files },
  );

  return output;
}
