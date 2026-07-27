import type { ResolvedLiminaConfig } from '#config/runner';
import { readJsonConfig } from '#core/tsconfig/actions';
import { collectTypeRootCandidates } from './generated/config-readers';
import { createRelativePath } from './generated/paths';
import type { SourceProject } from './types';

function isNonArrayObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function getConfiguredTypes(value: unknown): unknown[] | null {
  const types = isNonArrayObject(value)
    ? (value as { types?: unknown }).types
    : undefined;
  return asArray(types);
}

function isPortableTypeName(typeName: unknown): boolean {
  if (typeof typeName !== 'string') {
    return true;
  }

  return !typeName.startsWith('./') && !typeName.startsWith('../');
}

export function createGeneratedCompilerOptionOverrides(options: {
  config: ResolvedLiminaConfig;
  project: SourceProject;
}): Record<string, unknown> {
  const configObject = readJsonConfig(
    options.config,
    options.project.configPath,
  );
  const output: Record<string, unknown> = {};
  const types = getConfiguredTypes(configObject.compilerOptions);
  if (types) {
    output.types = types.filter(isPortableTypeName);
  }

  const typeRoots = collectTypeRootCandidates({
    rootDir: options.config.rootDir,
    sourceConfigPath: options.project.configPath,
  });
  if (typeRoots.length > 0) {
    output.typeRoots = typeRoots.map((typeRoot) =>
      createRelativePath(options.project.dtsConfigPath, typeRoot),
    );
  }

  return output;
}
