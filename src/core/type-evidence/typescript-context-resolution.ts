import type { TypeScriptSemanticContext } from '../typescript-semantic';
import type { TypeEvidenceGenerationCache } from './cache';
import { createTypeScriptProviderKey } from './provider-resolution';
import { resolveTypeScriptPreset } from './resolution';
import type { WorkspaceBoundedImportEvidenceOptions } from './types';
import { getOrCreateTypeScriptSemanticContext } from './typescript-provider';

export function getCoreTypeScriptSemanticContext(options: {
  cache: TypeEvidenceGenerationCache;
  checkerName: string;
  generation: number;
  prepareProvider(configPath: string, providerKey: string): void;
  project: WorkspaceBoundedImportEvidenceOptions['project'];
}): TypeScriptSemanticContext {
  const preset = resolveTypeScriptPreset(options.project.checkerPresets);
  if (preset === null) {
    throw new Error(
      `Checker ${options.checkerName} has no native TypeScript semantic context.`,
    );
  }
  const providerKey = createTypeScriptProviderKey({
    checkerName: options.checkerName,
    configPath: options.project.configPath,
    generation: options.generation,
    preset,
    project: options.project,
  });
  options.prepareProvider(options.project.configPath, providerKey);
  return getOrCreateTypeScriptSemanticContext({
    cache: options.cache,
    programKey: providerKey,
    project: options.project,
  });
}
