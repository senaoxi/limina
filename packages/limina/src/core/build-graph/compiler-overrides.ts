import type { ResolvedLiminaConfig } from '#config/runner';
import path from 'pathe';
import ts from 'typescript';
import { isRelativeTypeName } from '../typescript-semantic/effective-roots';
import { collectTypeRootCandidates } from './generated/config-readers';
import { createRelativePath } from './generated/paths';
import type { SourceProject } from './types';

function getSourceTypeNames(project: SourceProject): string[] {
  const compiler =
    project.context.vueSemanticIdentity?.toolchain.tsModule ?? ts;
  return compiler.getAutomaticTypeDirectiveNames(project.options, {
    ...compiler.sys,
    getCurrentDirectory: () => path.dirname(project.configPath),
  });
}

function createGeneratedTypeRootOverrides(options: {
  config: ResolvedLiminaConfig;
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
  config: ResolvedLiminaConfig;
  project: SourceProject;
  generatedConfigPath: string;
}): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const types = options.project.options.types;
  if (types !== undefined) {
    output.types = getSourceTypeNames(options.project).filter(
      (name) => !isRelativeTypeName(name),
    );
  }

  Object.assign(output, createGeneratedTypeRootOverrides(options));

  return output;
}
