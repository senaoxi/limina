import type {
  ImportAnalysisContext,
  ImportRecord,
} from '#core/import-analysis/runner';
import type { ProjectInfo } from '#core/import-graph/context';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import {
  classifyImportRuntimeEvidence,
  type ImportResolutionEvidence,
  type ImportRuntimeResolutionEvidence,
} from '../import-analysis/evidence';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import {
  createImportTypeEvidenceCacheKey,
  createTypeEvidenceProviderCacheKey,
  type TypeEvidence,
  TypeEvidenceGenerationCache,
  type TypeEvidenceMetricsRecorder,
} from './cache';
import { createTypeScriptTypeEvidenceProvider } from './typescript-provider';
import {
  createVueTypeEvidenceProvider,
  resolveVueTypeEvidenceCapability,
  type VueTypeEvidenceCapability,
} from './vue-provider';

export * from './cache';

export interface TypeEvidenceCoreOptions {
  generation: number;
  importAnalysis: ImportAnalysisContext;
  metrics?: TypeEvidenceMetricsRecorder;
}

export interface ResolveImportEvidenceOptions {
  checkerName: string;
  importRecord: ImportRecord;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
  project: Pick<
    ProjectInfo,
    | 'checkerPresets'
    | 'configPath'
    | 'extensions'
    | 'fileNames'
    | 'options'
    | 'resolverConfigPath'
  >;
}

export class TypeEvidenceCore {
  readonly cache: TypeEvidenceGenerationCache;
  readonly #affectedSourceConfigs: Set<string> | undefined;
  readonly #generation: number;
  readonly #importAnalysis: ImportAnalysisContext;
  readonly #metrics: TypeEvidenceMetricsRecorder | undefined;
  readonly #completedConfigIdentities = new Set<string>();
  readonly #providerKeysByConfigIdentity = new Map<string, Set<string>>();
  readonly #vueCapabilities = new Map<string, VueTypeEvidenceCapability>();

  constructor(options: TypeEvidenceCoreOptions) {
    this.cache = new TypeEvidenceGenerationCache(options.metrics);
    this.#affectedSourceConfigs = options.metrics ? new Set() : undefined;
    this.#generation = options.generation;
    this.#importAnalysis = options.importAnalysis;
    this.#metrics = options.metrics;
  }

  classifyImportRuntime(
    options: ResolveImportEvidenceOptions,
  ): ImportRuntimeResolutionEvidence {
    const pair = this.#importAnalysis.resolveModulePair(
      options.importRecord.specifier,
      options.importRecord.filePath,
      options.project.options,
      options.project,
    );

    return classifyImportRuntimeEvidence({
      compilerOptions: options.project.options,
      containingFile: options.importRecord.filePath,
      extensions: options.project.extensions,
      oxcResolvedFilePath: pair.oxc,
      specifier: options.importRecord.specifier,
      typeScriptResolution: pair.typescript,
    });
  }

  resolveImportEvidence(
    options: ResolveImportEvidenceOptions,
  ): ImportResolutionEvidence {
    const configIdentity = normalizeAbsolutePathIdentity(
      options.project.configPath,
    );

    const pair = this.#importAnalysis.resolveModulePair(
      options.importRecord.specifier,
      options.importRecord.filePath,
      options.project.options,
      options.project,
    );
    const runtimeEvidence = classifyImportRuntimeEvidence({
      compilerOptions: options.project.options,
      containingFile: options.importRecord.filePath,
      extensions: options.project.extensions,
      oxcResolvedFilePath: pair.oxc,
      specifier: options.importRecord.specifier,
      typeScriptResolution: pair.typescript,
    });

    if (runtimeEvidence.classification === 'resource') {
      this.#metrics?.record({ name: 'resource-import-count' });
      this.#metrics?.record({ name: 'type-evidence-query' });

      if (!this.#affectedSourceConfigs?.has(configIdentity)) {
        this.#affectedSourceConfigs?.add(configIdentity);
        this.#metrics?.record({ name: 'affected-source-config-count' });
      }
    }

    const concreteTypeEvidence = this.#resolveConcreteTypeEvidence(
      options,
      pair.typescript,
    );

    if (concreteTypeEvidence) {
      return { ...runtimeEvidence, type: concreteTypeEvidence };
    }

    const vuePreset = this.#resolveVuePreset(options.project.checkerPresets);

    if (vuePreset) {
      return this.#resolveVueImportEvidence({
        options,
        preset: vuePreset,
        runtimeEvidence,
      });
    }

    const preset = this.#resolveTypeScriptPreset(
      options.project.checkerPresets,
    );

    if (!preset) {
      return {
        ...runtimeEvidence,
        type: {
          checker: options.checkerName,
          kind: 'unsupported-checker',
          reason:
            'This checker does not expose a supported resource type-evidence provider.',
        },
      };
    }

    return this.#resolveTypeScriptImportEvidence({
      options,
      preset,
      runtimeEvidence,
    });
  }

  #resolveTypeScriptImportEvidence(input: {
    options: ResolveImportEvidenceOptions;
    preset: string;
    runtimeEvidence: ImportRuntimeResolutionEvidence;
  }): ImportResolutionEvidence {
    const providerKey = createTypeEvidenceProviderCacheKey({
      checkerName: input.options.checkerName,
      configPath: input.options.project.configPath,
      generation: this.#generation,
      preset: input.preset,
    });
    const queryKey = createImportTypeEvidenceCacheKey({
      importRecord: input.options.importRecord,
      providerKey,
    });
    const cached = this.cache.getImportEvidence(queryKey);

    if (cached) {
      return { ...input.runtimeEvidence, type: cached };
    }

    this.#assertConfigNotCompleted(input.options.project.configPath);
    this.#trackProviderKey(input.options.project.configPath, providerKey);

    const provider = this.cache.getOrCreateProvider(
      providerKey,
      () =>
        createTypeScriptTypeEvidenceProvider({
          cache: this.cache,
          programKey: providerKey,
          project: input.options.project,
        }),
      input.preset,
    );
    const type = provider.query({
      importRecord: input.options.importRecord,
    });

    this.cache.setImportEvidence(queryKey, type);
    return { ...input.runtimeEvidence, type };
  }

  #resolveConcreteTypeEvidence(
    options: ResolveImportEvidenceOptions,
    resolution: ReturnType<ImportAnalysisContext['resolveTypeScriptImport']>,
  ): TypeEvidence | null {
    if (resolution?.resolvedBy === 'checker-source') {
      return {
        filePath: resolution.resolvedFileName,
        kind: 'checker-source',
      };
    }

    if (!resolution || !isDeclarationFile(resolution.resolvedFileName)) {
      return null;
    }

    const managedSource = options.managedOutputLookup?.resolve(
      resolution.resolvedFileName,
      options.checkerName,
    );

    return {
      filePath: resolution.resolvedFileName,
      kind: 'concrete-declaration',
      ...(managedSource ? { managedSource } : {}),
    };
  }

  #resolveTypeScriptPreset(checkerPresets: readonly string[]): string | null {
    const presets = checkerPresets.length > 0 ? checkerPresets : ['tsc'];

    if (presets.includes('vue-tsc') || presets.includes('vue-tsgo')) {
      return null;
    }

    return (
      presets.find((preset) => preset === 'tsc' || preset === 'tsgo') ?? null
    );
  }

  #resolveVuePreset(checkerPresets: readonly string[]): string | null {
    return (
      checkerPresets.find(
        (preset) => preset === 'vue-tsc' || preset === 'vue-tsgo',
      ) ?? null
    );
  }

  #resolveVueImportEvidence(input: {
    options: ResolveImportEvidenceOptions;
    preset: string;
    runtimeEvidence: ImportRuntimeResolutionEvidence;
  }): ImportResolutionEvidence {
    const configPath = input.options.project.configPath;
    let capability = this.#vueCapabilities.get(configPath);

    if (!capability) {
      capability = resolveVueTypeEvidenceCapability(configPath);
      this.#vueCapabilities.set(configPath, capability);
    }

    const versionTuple =
      capability.versionTuple === undefined
        ? []
        : [
            capability.versionTuple.vueTsc,
            capability.versionTuple.languageCore,
            capability.versionTuple.volarTypeScript,
            capability.versionTuple.typeScript,
          ];
    const providerKey = createTypeEvidenceProviderCacheKey({
      checkerName: input.options.checkerName,
      configPath,
      generation: this.#generation,
      preset: input.preset,
      versionTuple,
    });
    const queryKey = createImportTypeEvidenceCacheKey({
      importRecord: input.options.importRecord,
      providerKey,
    });
    const cached = this.cache.getImportEvidence(queryKey);

    if (cached) {
      return { ...input.runtimeEvidence, type: cached };
    }

    this.#assertConfigNotCompleted(configPath);
    this.#trackProviderKey(configPath, providerKey);

    if (input.preset !== 'vue-tsc') {
      const type: TypeEvidence = {
        checker: input.options.checkerName,
        kind: 'unsupported-checker',
        reason: `Checker preset ${input.preset} does not have an approved Vue type-evidence adapter.`,
      };

      this.cache.setImportEvidence(queryKey, type);
      return { ...input.runtimeEvidence, type };
    }

    if (capability.kind === 'unsupported') {
      const type: TypeEvidence = {
        checker: input.options.checkerName,
        kind: 'unsupported-checker',
        reason: capability.reason,
      };

      this.cache.setImportEvidence(queryKey, type);
      return { ...input.runtimeEvidence, type };
    }

    const provider = this.cache.getOrCreateProvider(
      providerKey,
      () =>
        createVueTypeEvidenceProvider({
          cache: this.cache,
          capability,
          checkerName: input.options.checkerName,
          programKey: providerKey,
          project: input.options.project,
        }),
      input.preset,
    );
    const type = provider.query({ importRecord: input.options.importRecord });

    this.cache.setImportEvidence(queryKey, type);
    return { ...input.runtimeEvidence, type };
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
    for (const key of this.#providerKeysByConfigIdentity.get(configIdentity) ??
      []) {
      this.cache.releaseProviderAndProgram(key);
    }
    this.#providerKeysByConfigIdentity.delete(configIdentity);
  }

  #assertConfigNotCompleted(configPath: string): void {
    if (
      this.#completedConfigIdentities.has(
        normalizeAbsolutePathIdentity(configPath),
      )
    ) {
      throw new Error(
        `Type evidence for ${configPath} was already completed in generation ${this.#generation}.`,
      );
    }
  }

  #trackProviderKey(configPath: string, providerKey: string): void {
    const configIdentity = normalizeAbsolutePathIdentity(configPath);
    const keys = this.#providerKeysByConfigIdentity.get(configIdentity);

    if (keys) {
      keys.add(providerKey);
      return;
    }

    this.#providerKeysByConfigIdentity.set(
      configIdentity,
      new Set([providerKey]),
    );
  }
}
