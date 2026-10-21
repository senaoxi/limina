import type {
  TypeScriptSemanticContext,
  TypeScriptSemanticDependencyContext,
} from '../typescript-semantic';
import {
  createTypeScriptDependencyContext,
  createTypeScriptSemanticContextIdentity,
  createTypeScriptSemanticDependencySnapshot,
} from '../typescript-semantic';
import type { TypeEvidenceGenerationCache } from './cache';
import { createTypeScriptProviderKey } from './provider-resolution';
import type { ResolveImportEvidenceOptions } from './resolution';
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
    project: {
      ...options.project,
      analysisBinding: options.project.analysisBinding ?? {
        phase: 'locked',
        checker: options.checkerName,
      },
    },
  });
}

type CoreContextOptions = Parameters<
  typeof getCoreTypeScriptSemanticContext
>[0];
function coreBinding(options: CoreContextOptions) {
  return (
    options.project.analysisBinding ?? {
      phase: 'locked' as const,
      checker: options.checkerName,
    }
  );
}
function restoreCoreContext(
  options: CoreContextOptions,
): TypeScriptSemanticDependencyContext | undefined {
  if (resolveTypeScriptPreset(options.project.checkerPresets) === null)
    return undefined;
  return options.cache.analysisCache?.restoreContext({
    ...options.project,
    admissionMode: 'coverage-bounded',
    analysisBinding: coreBinding(options),
  });
}
export function getCoreTypeScriptSemanticDependencyContext(
  options: CoreContextOptions,
): TypeScriptSemanticDependencyContext {
  const project = {
    ...options.project,
    admissionMode: 'coverage-bounded' as const,
    analysisBinding: coreBinding(options),
  };
  const key = createTypeScriptSemanticContextIdentity(project);
  const prior =
    options.cache.dependencyContexts.get(key) ?? restoreCoreContext(options);
  if (prior !== undefined) return prior;
  const context = createTypeScriptDependencyContext(project, {
    analysisCache: options.cache.analysisCache,
    metrics: options.cache.metrics,
  });
  try {
    const snapshot = createTypeScriptSemanticDependencySnapshot({
      context,
      fileNames: project.fileNames,
    });
    options.cache.dependencyContexts.set(key, snapshot);
    return snapshot;
  } finally {
    context.dispose();
  }
}

export interface TypeScriptContextRequest {
  checkerName: string;
  project: ResolveImportEvidenceOptions['project'];
}
