import type { ResolvedLiminaConfig } from '#config/runner';
import { isRelativeTypeName } from '../typescript-semantic/effective-roots';
import { collectTypeRootCandidates } from './generated/config-readers';
import { createRelativePath } from './generated/paths';
import type { SourceProject } from './types';

function createGeneratedTypeRootOverrides(options: {
  config: ResolvedLiminaConfig;
  project: SourceProject;
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
      createRelativePath(options.project.dtsConfigPath, typeRoot),
    ),
  };
}

export function createGeneratedCompilerOptionOverrides(options: {
  config: ResolvedLiminaConfig;
  project: SourceProject;
}): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const types = options.project.options.types;
  if (types !== undefined) {
    output.types = types.filter((name) => !isRelativeTypeName(name));
  }

  Object.assign(output, createGeneratedTypeRootOverrides(options));

  return output;
}
