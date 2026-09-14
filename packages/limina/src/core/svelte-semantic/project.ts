import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type ts from 'typescript';
import {
  SVELTE_SEMANTIC_ADAPTER_VERSION,
  type SvelteSemanticProject,
} from './types';

export function createSvelteSemanticProject(options: {
  configClosure?: SvelteSemanticProject['configClosure'];
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
    configClosure: options.configClosure,
    packageIdentity: createPackageIdentity(options.packageRootDir),
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

function createPackageIdentity(packageRootDir: string): string {
  const fileName = path.join(packageRootDir, 'package.json');
  try {
    return createHash('sha256')
      .update(normalizeAbsolutePath(realpathSync(fileName)))
      .update(readFileSync(fileName))
      .digest('hex');
  } catch {
    return 'missing';
  }
}
