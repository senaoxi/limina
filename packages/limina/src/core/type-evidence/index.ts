import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import type {
  ImportResolutionEvidence,
  ImportRuntimeResolutionEvidence,
} from '../import-analysis/evidence';
import {
  TypeEvidenceGenerationCache,
  type TypeEvidenceMetricsRecorder,
} from './cache';
import {
  resolveTypeScriptProviderEvidence,
  resolveVueProviderEvidence,
} from './provider-resolution';
import type { ResolveImportEvidenceOptions } from './resolution';
import {
  createUnsupportedCheckerEvidence,
  resolveConcreteTypeEvidence,
  resolveImportPair,
  resolveTypeScriptPreset,
  resolveVuePreset,
} from './resolution';
import type { TypeEvidenceCoreOptions } from './types';
import {
  resolveVueTypeEvidenceCapability,
  type VueTypeEvidenceCapability,
} from './vue-provider';

export * from './cache';
export type { ResolveImportEvidenceOptions } from './resolution';
export type { TypeEvidenceCoreOptions } from './types';

type ResourceMetricName =
  | 'affected-source-config-count'
  | 'resource-import-count'
  | 'type-evidence-query';

function recordMetric(
  metrics: TypeEvidenceMetricsRecorder | undefined,
  name: ResourceMetricName,
): void {
  if (metrics !== undefined) {
    metrics.record({ name });
  }
}

function hasAffectedConfig(
  affectedConfigs: ReadonlySet<string> | undefined,
  configIdentity: string,
): boolean {
  return affectedConfigs !== undefined && affectedConfigs.has(configIdentity);
}

function addAffectedConfig(
  affectedConfigs: Set<string> | undefined,
  configIdentity: string,
): void {
  if (affectedConfigs !== undefined) {
    affectedConfigs.add(configIdentity);
  }
}

export class TypeEvidenceCore {
  readonly cache: TypeEvidenceGenerationCache;
  readonly #affectedSourceConfigs: Set<string> | undefined;
  readonly #completedConfigIdentities = new Set<string>();
  readonly #generation: number;
  readonly #importAnalysis: ImportAnalysisContext;
  readonly #metrics: TypeEvidenceMetricsRecorder | undefined;
  readonly #providerKeysByConfigIdentity = new Map<string, Set<string>>();
  readonly #vueCapabilities = new Map<string, VueTypeEvidenceCapability>();

  constructor(options: TypeEvidenceCoreOptions) {
    this.cache = new TypeEvidenceGenerationCache(options.metrics);
    this.#affectedSourceConfigs =
      options.metrics === undefined ? undefined : new Set();
    this.#generation = options.generation;
    this.#importAnalysis = options.importAnalysis;
    this.#metrics = options.metrics;
  }

  classifyImportRuntime(
    options: ResolveImportEvidenceOptions,
  ): ImportRuntimeResolutionEvidence {
    return resolveImportPair({
      importAnalysis: this.#importAnalysis,
      request: options,
    }).runtimeEvidence;
  }

  resolveImportEvidence(
    options: ResolveImportEvidenceOptions,
  ): ImportResolutionEvidence {
    const configIdentity = normalizeAbsolutePathIdentity(
      options.project.configPath,
    );
    const pair = resolveImportPair({
      importAnalysis: this.#importAnalysis,
      request: options,
    });
    this.#recordResourceImport(configIdentity, pair.runtimeEvidence);

    const concreteTypeEvidence = resolveConcreteTypeEvidence({
      request: options,
      resolution: pair.typeScriptResolution,
    });

    if (concreteTypeEvidence !== null) {
      return { ...pair.runtimeEvidence, type: concreteTypeEvidence };
    }

    return this.#resolveProviderEvidence(options, pair.runtimeEvidence);
  }

  #recordResourceImport(
    configIdentity: string,
    runtimeEvidence: ImportRuntimeResolutionEvidence,
  ): void {
    if (runtimeEvidence.classification !== 'resource') {
      return;
    }

    recordMetric(this.#metrics, 'resource-import-count');
    recordMetric(this.#metrics, 'type-evidence-query');

    if (hasAffectedConfig(this.#affectedSourceConfigs, configIdentity)) {
      return;
    }

    addAffectedConfig(this.#affectedSourceConfigs, configIdentity);
    recordMetric(this.#metrics, 'affected-source-config-count');
  }

  #resolveProviderEvidence(
    options: ResolveImportEvidenceOptions,
    runtimeEvidence: ImportRuntimeResolutionEvidence,
  ): ImportResolutionEvidence {
    const vuePreset = resolveVuePreset(options.project.checkerPresets);

    if (vuePreset !== null) {
      return resolveVueProviderEvidence({
        context: this.#createVueProviderContext(),
        input: { options, preset: vuePreset, runtimeEvidence },
      });
    }

    const preset = resolveTypeScriptPreset(options.project.checkerPresets);

    if (preset === null) {
      return {
        ...runtimeEvidence,
        type: createUnsupportedCheckerEvidence({
          checkerName: options.checkerName,
          reason:
            'This checker does not expose a supported resource type-evidence provider.',
        }),
      };
    }

    return resolveTypeScriptProviderEvidence({
      context: this.#createProviderContext(),
      input: { options, preset, runtimeEvidence },
    });
  }

  #createProviderContext() {
    return {
      cache: this.cache,
      generation: this.#generation,
      prepareProvider: (configPath: string, providerKey: string) =>
        this.#prepareProvider(configPath, providerKey),
    };
  }

  #createVueProviderContext() {
    return {
      ...this.#createProviderContext(),
      getCapability: (configPath: string) => this.#getVueCapability(configPath),
    };
  }

  #getVueCapability(configPath: string): VueTypeEvidenceCapability {
    const cached = this.#vueCapabilities.get(configPath);

    if (cached !== undefined) {
      return cached;
    }

    const capability = resolveVueTypeEvidenceCapability(configPath);
    this.#vueCapabilities.set(configPath, capability);
    return capability;
  }

  #prepareProvider(configPath: string, providerKey: string): void {
    this.#assertConfigNotCompleted(configPath);
    this.#trackProviderKey(configPath, providerKey);
  }

  dispose(): void {
    this.cache.dispose();
    this.#affectedSourceConfigs?.clear();
    this.#completedConfigIdentities.clear();
    this.#providerKeysByConfigIdentity.clear();
    this.#vueCapabilities.clear();
  }

  completeProject(configPath: string): void {
    const configIdentity = normalizeAbsolutePathIdentity(configPath);

    if (this.#completedConfigIdentities.has(configIdentity)) {
      return;
    }

    this.#completedConfigIdentities.add(configIdentity);
    for (const key of this.#getProviderKeys(configIdentity)) {
      this.cache.releaseProviderAndProgram(key);
    }
    this.#providerKeysByConfigIdentity.delete(configIdentity);
  }

  #getProviderKeys(configIdentity: string): readonly string[] {
    const keys = this.#providerKeysByConfigIdentity.get(configIdentity);
    return keys === undefined ? [] : [...keys];
  }

  #assertConfigNotCompleted(configPath: string): void {
    const identity = normalizeAbsolutePathIdentity(configPath);

    if (this.#completedConfigIdentities.has(identity)) {
      throw new Error(
        `Type evidence for ${configPath} was already completed in generation ${this.#generation}.`,
      );
    }
  }

  #trackProviderKey(configPath: string, providerKey: string): void {
    const configIdentity = normalizeAbsolutePathIdentity(configPath);
    const keys = this.#providerKeysByConfigIdentity.get(configIdentity);

    if (keys !== undefined) {
      keys.add(providerKey);
      return;
    }

    this.#providerKeysByConfigIdentity.set(
      configIdentity,
      new Set([providerKey]),
    );
  }
}
