import type { VueProjectSemanticIdentity } from '#checkers';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import { formatFrameworkSemanticFailure } from '../framework-semantic/contracts';
import type {
  ImportResolutionEvidence,
  ImportRuntimeResolutionEvidence,
} from '../import-analysis/evidence';
import type {
  TypeScriptSemanticContext,
  TypeScriptSemanticDependencyContext,
} from '../typescript-semantic';
import { VueSemanticContextManager } from '../vue-semantic/context';
import {
  TypeEvidenceGenerationCache,
  type TypeEvidenceMetricsRecorder,
} from './cache';
import { resolveCoreTypeEvidence } from './native-evidence';
import type { ResolveImportEvidenceOptions } from './resolution';
import {
  createUnsupportedCheckerEvidence,
  resolveImportPair,
  resolveTypeScriptPreset,
} from './resolution';
import {
  addAffectedConfig,
  hasAffectedConfig,
  recordMetric,
} from './resource-metrics';
import { resolveResourceProviderEvidence } from './resource-provider-resolution';
import type {
  TypeEvidenceCoreOptions,
  WorkspaceBoundedImportEvidenceOptions,
} from './types';
import type { TypeScriptContextRequest } from './typescript-context-resolution';
import {
  getCoreTypeScriptSemanticContext,
  getCoreTypeScriptSemanticDependencyContext,
} from './typescript-context-resolution';
import {
  resolveVueTypeEvidenceCapability,
  type VueTypeEvidenceCapability,
} from './vue-provider';
import { addWorkspaceSourceBoundary } from './workspace-boundary';

export * from './cache';
export type { ResolveImportEvidenceOptions } from './resolution';
export type { TypeEvidenceCoreOptions } from './types';

function getVueCapabilityKey(
  identity: VueProjectSemanticIdentity | undefined,
): string {
  return identity === undefined ? '<missing>' : identity.id;
}

export class TypeEvidenceCore {
  readonly #affectedSourceConfigs: Set<string> | undefined;
  readonly #completedConfigIdentities = new Set<string>();
  readonly #generation: number;
  readonly #importAnalysis: ImportAnalysisContext;
  readonly #metrics: TypeEvidenceMetricsRecorder | undefined;
  readonly #providerKeysByConfigIdentity = new Map<string, Set<string>>();
  readonly #vueCapabilities = new Map<string, VueTypeEvidenceCapability>();
  readonly #vueSemanticContexts: VueSemanticContextManager;
  readonly #ownsVueSemanticContexts: boolean;
  readonly #workspaceSourceBoundaryProvider: TypeEvidenceCoreOptions['workspaceSourceBoundaryProvider'];
  readonly cache: TypeEvidenceGenerationCache;

  constructor(options: TypeEvidenceCoreOptions) {
    this.cache = new TypeEvidenceGenerationCache(
      options.metrics,
      options.syntaxFacts,
      options.analysisCache,
    );
    this.#affectedSourceConfigs =
      options.metrics === undefined ? undefined : new Set();
    this.#generation = options.generation;
    this.#importAnalysis = options.importAnalysis;
    this.#metrics = options.metrics;
    this.#ownsVueSemanticContexts = options.vueSemanticContexts === undefined;
    this.#vueSemanticContexts =
      options.vueSemanticContexts ??
      new VueSemanticContextManager(options.metrics);
    this.#workspaceSourceBoundaryProvider =
      options.workspaceSourceBoundaryProvider;
  }

  #getNativeTypeScriptSemanticContext(
    options: WorkspaceBoundedImportEvidenceOptions,
  ): TypeScriptSemanticDependencyContext | undefined {
    return resolveTypeScriptPreset(options.project.checkerPresets) === null
      ? undefined
      : this.getTypeScriptSemanticDependencyContext(options);
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
    options: WorkspaceBoundedImportEvidenceOptions,
    runtimeEvidence: ImportRuntimeResolutionEvidence,
  ): ImportResolutionEvidence {
    return resolveResourceProviderEvidence({
      request: options,
      runtimeEvidence,
      nativeContext: this.#createProviderContext(),
      vueContext: this.#createVueProviderContext(),
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
      contexts: this.#vueSemanticContexts,
      getCapability: (identity: VueProjectSemanticIdentity | undefined) =>
        this.#getVueCapability(identity),
    };
  }

  #getVueCapability(
    identity: VueProjectSemanticIdentity | undefined,
  ): VueTypeEvidenceCapability {
    const key = getVueCapabilityKey(identity);
    const cached = this.#vueCapabilities.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const capability = resolveVueTypeEvidenceCapability(identity);
    this.#vueCapabilities.set(key, capability);
    return capability;
  }

  #prepareProvider(configPath: string, providerKey: string): void {
    this.#assertConfigNotCompleted(configPath);
    this.#trackProviderKey(configPath, providerKey);
  }

  #getProviderKeys(configIdentity: string): readonly string[] {
    return [...(this.#providerKeysByConfigIdentity.get(configIdentity) ?? [])];
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

  #nativeOptions(options: TypeScriptContextRequest) {
    return {
      cache: this.cache,
      checkerName: options.checkerName,
      generation: this.#generation,
      prepareProvider: (configPath: string, providerKey: string) =>
        this.#prepareProvider(configPath, providerKey),
      project: {
        ...options.project,
        workspaceSourceBoundary: this.#workspaceSourceBoundaryProvider(
          options.project,
        ),
      },
    };
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
    const boundedOptions = addWorkspaceSourceBoundary({
      input: options,
      provider: this.#workspaceSourceBoundaryProvider,
    });
    const configIdentity = normalizeAbsolutePathIdentity(
      options.project.configPath,
    );
    const typeScriptSemanticContext =
      this.#getNativeTypeScriptSemanticContext(boundedOptions);
    const pair = resolveImportPair({
      importAnalysis: this.#importAnalysis,
      request: boundedOptions,
      typeScriptSemanticContext,
    });
    this.#recordResourceImport(configIdentity, pair.runtimeEvidence);

    if (pair.semanticFailure !== undefined) {
      return {
        ...pair.runtimeEvidence,
        type: createUnsupportedCheckerEvidence({
          checkerName: options.checkerName,
          reason: formatFrameworkSemanticFailure(pair.semanticFailure),
        }),
      };
    }

    return resolveCoreTypeEvidence({
      native: typeScriptSemanticContext !== undefined,
      pair,
      request: boundedOptions,
      resolveProvider: () =>
        this.#resolveProviderEvidence(boundedOptions, pair.runtimeEvidence),
    });
  }

  getTypeScriptSemanticContext(
    options: TypeScriptContextRequest,
  ): TypeScriptSemanticContext {
    return getCoreTypeScriptSemanticContext(this.#nativeOptions(options));
  }
  getTypeScriptSemanticDependencyContext(
    options: TypeScriptContextRequest,
  ): TypeScriptSemanticDependencyContext {
    return getCoreTypeScriptSemanticDependencyContext(
      this.#nativeOptions(options),
    );
  }

  dispose(): void {
    this.cache.dispose();
    this.#affectedSourceConfigs?.clear();
    this.#completedConfigIdentities.clear();
    this.#providerKeysByConfigIdentity.clear();
    this.#vueCapabilities.clear();
    if (this.#ownsVueSemanticContexts) {
      this.#vueSemanticContexts.dispose();
    }
  }

  completeProject(configPath: string): void {
    const configIdentity = normalizeAbsolutePathIdentity(configPath);

    if (this.#completedConfigIdentities.has(configIdentity)) return;

    this.#completedConfigIdentities.add(configIdentity);
    for (const key of this.#getProviderKeys(configIdentity)) {
      this.cache.releaseProviderAndProgram(key);
    }
    this.#providerKeysByConfigIdentity.delete(configIdentity);
  }
}
