import type { ResolvedLiminaInputs } from '#config/runner';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { collectTypeRootCandidates } from './generated/config-readers';
import { createRelativePath } from './generated/paths';
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
  const output = createGeneratedTypeRootOverrides(options);
  output.types = projectTypeDirectiveNames(
    options.project,
    options.generatedConfigPath,
    { overrides: output, cache: options.cache },
  );

  return output;
}
