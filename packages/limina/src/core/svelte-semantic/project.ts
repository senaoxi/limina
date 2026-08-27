import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import {
  SVELTE_SEMANTIC_ADAPTER_VERSION,
  type SvelteSemanticProject,
} from './types';

export function createSvelteSemanticProject(options: {
  configPath: string;
  extensions: readonly string[];
  fileNames: readonly string[];
  generation: number;
  options: ts.CompilerOptions;
  packageRootDir: string;
  resolverConfigPath?: string;
}): SvelteSemanticProject {
  return {
    adapterVersion: SVELTE_SEMANTIC_ADAPTER_VERSION,
    configPath: normalizeAbsolutePath(options.configPath),
    extensions: [...options.extensions],
    fileNames: options.fileNames.map(normalizeAbsolutePath),
    generation: options.generation,
    options: options.options,
    packageRootDir: normalizeAbsolutePath(options.packageRootDir),
    resolverConfigPath: normalizeAbsolutePath(
      options.resolverConfigPath ?? options.configPath,
    ),
  };
}
