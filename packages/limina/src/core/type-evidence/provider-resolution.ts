import type { ImportResolutionEvidence } from '../import-analysis/evidence';
import {
  createImportTypeEvidenceCacheKey,
  createTypeEvidenceProviderCacheKey,
  type TypeEvidence,
  type TypeEvidenceGenerationCache,
} from './cache';
import {
  createVueVersionTuple,
  resolveUnsupportedVueEvidence,
} from './resolution';
import type { ProviderEvidenceInput } from './types';
import { createTypeScriptTypeEvidenceProvider } from './typescript-provider';
import {
  createVueTypeEvidenceProvider,
  type VueTypeEvidenceCapability,
} from './vue-provider';

interface ProviderResolutionContext {
  cache: TypeEvidenceGenerationCache;
  generation: number;
  prepareProvider(configPath: string, providerKey: string): void;
}

interface VueProviderResolutionContext extends ProviderResolutionContext {
  getCapability(configPath: string): VueTypeEvidenceCapability;
}

type SupportedVueTypeEvidenceCapability = Extract<
  VueTypeEvidenceCapability,
  { kind: 'supported' }
>;

function assertSupportedVueCapability(
  capability: VueTypeEvidenceCapability,
): asserts capability is SupportedVueTypeEvidenceCapability {
  if (capability.kind !== 'supported') {
    throw new Error('Unsupported Vue capability reached provider creation.');
  }
}

function createProviderKey(options: {
  generation: number;
  input: ProviderEvidenceInput;
  versionTuple?: readonly string[];
}): string {
  return createTypeEvidenceProviderCacheKey({
    checkerName: options.input.options.checkerName,
    configPath: options.input.options.project.configPath,
    generation: options.generation,
    preset: options.input.preset,
    versionTuple: options.versionTuple ?? [],
  });
}

function createQueryKey(
  input: ProviderEvidenceInput,
  providerKey: string,
): string {
  return createImportTypeEvidenceCacheKey({
    importRecord: input.options.importRecord,
    providerKey,
  });
}

function getCachedEvidence(options: {
  cache: TypeEvidenceGenerationCache;
  input: ProviderEvidenceInput;
  queryKey: string;
}): ImportResolutionEvidence | null {
  const cached = options.cache.getImportEvidence(options.queryKey);
  return cached === undefined
    ? null
    : { ...options.input.runtimeEvidence, type: cached };
}

function cacheEvidence(options: {
  cache: TypeEvidenceGenerationCache;
  input: ProviderEvidenceInput;
  queryKey: string;
  type: TypeEvidence;
}): ImportResolutionEvidence {
  options.cache.setImportEvidence(options.queryKey, options.type);
  return { ...options.input.runtimeEvidence, type: options.type };
}

export function resolveTypeScriptProviderEvidence(options: {
  context: ProviderResolutionContext;
  input: ProviderEvidenceInput;
}): ImportResolutionEvidence {
  const providerKey = createProviderKey({
    generation: options.context.generation,
    input: options.input,
  });
  const queryKey = createQueryKey(options.input, providerKey);
  const cached = getCachedEvidence({
    cache: options.context.cache,
    input: options.input,
    queryKey,
  });

  if (cached !== null) {
    return cached;
  }

  options.context.prepareProvider(
    options.input.options.project.configPath,
    providerKey,
  );
  const provider = options.context.cache.getOrCreateProvider(
    providerKey,
    () =>
      createTypeScriptTypeEvidenceProvider({
        cache: options.context.cache,
        programKey: providerKey,
        project: options.input.options.project,
      }),
    options.input.preset,
  );
  const type = provider.query({
    importRecord: options.input.options.importRecord,
  });

  return cacheEvidence({
    cache: options.context.cache,
    input: options.input,
    queryKey,
    type,
  });
}

export function resolveVueProviderEvidence(options: {
  context: VueProviderResolutionContext;
  input: ProviderEvidenceInput;
}): ImportResolutionEvidence {
  const configPath = options.input.options.project.configPath;
  const capability = options.context.getCapability(configPath);
  const providerKey = createProviderKey({
    generation: options.context.generation,
    input: options.input,
    versionTuple: createVueVersionTuple(capability),
  });
  const queryKey = createQueryKey(options.input, providerKey);
  const cached = getCachedEvidence({
    cache: options.context.cache,
    input: options.input,
    queryKey,
  });

  if (cached !== null) {
    return cached;
  }

  options.context.prepareProvider(configPath, providerKey);
  const unsupported = resolveUnsupportedVueEvidence({
    capability,
    checkerName: options.input.options.checkerName,
    preset: options.input.preset,
  });

  if (unsupported !== null) {
    return cacheEvidence({
      cache: options.context.cache,
      input: options.input,
      queryKey,
      type: unsupported,
    });
  }

  assertSupportedVueCapability(capability);
  const provider = options.context.cache.getOrCreateProvider(
    providerKey,
    () =>
      createVueTypeEvidenceProvider({
        cache: options.context.cache,
        capability,
        checkerName: options.input.options.checkerName,
        programKey: providerKey,
        project: options.input.options.project,
      }),
    options.input.preset,
  );
  const type = provider.query({
    importRecord: options.input.options.importRecord,
  });

  return cacheEvidence({
    cache: options.context.cache,
    input: options.input,
    queryKey,
    type,
  });
}
