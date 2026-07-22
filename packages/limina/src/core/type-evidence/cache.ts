import type { ImportRecord } from '#core/import-analysis/runner';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import type ts from 'typescript';
import type { ManagedOutputDeclarationProvider } from '../import-graph/managed-output-provider';

export type TypeEvidence =
  | {
      filePath: string;
      kind: 'checker-source';
    }
  | {
      filePath: string;
      kind: 'concrete-declaration';
      managedSource?: ManagedOutputDeclarationProvider;
    }
  | {
      declarationFilePaths: string[];
      kind: 'ambient';
      modulePattern: string;
    }
  | {
      kind: 'missing';
    }
  | {
      checker: string;
      kind: 'unsupported-checker';
      reason: string;
    };

export interface TypeEvidenceQuery {
  importRecord: ImportRecord;
}

export interface TypeEvidenceProvider {
  dispose(): void;
  query(options: TypeEvidenceQuery): TypeEvidence;
}

export interface TypeEvidenceProgramHandle {
  dispose(): void;
  program: ts.Program;
}

export interface TypeEvidenceProviderIdentity {
  checkerName: string;
  configPath: string;
  generation: number;
  preset: string;
  versionTuple?: readonly string[];
}

export interface TypeEvidenceMetricsRecorder {
  record(measurement: {
    readonly count?: number;
    readonly durationMs?: number;
    readonly kind?: string;
    readonly name: (typeof TYPE_EVIDENCE_METRIC_NAMES)[number];
    readonly provider?: string;
  }): void;
}

export const TYPE_EVIDENCE_METRIC_NAMES = [
  'type-evidence-provider-create',
  'type-evidence-provider-hit',
  'typescript-program-create',
  'vue-program-create',
  'program-create-duration',
  'program-source-file-count',
  'type-evidence-query',
  'type-evidence-cache-hit',
  'ambient-symbol-hit',
  'ambient-symbol-miss',
  'affected-source-config-count',
  'resource-import-count',
] as const;

export type TypeEvidenceProviderCache = Map<string, TypeEvidenceProvider>;
export type ProgramCache = Map<string, TypeEvidenceProgramHandle>;
export type ImportTypeEvidenceCache = Map<string, TypeEvidence>;
export type AmbientSymbolLookupCache = WeakMap<ts.Symbol, TypeEvidence>;

export function createTypeEvidenceProviderCacheKey(
  identity: TypeEvidenceProviderIdentity,
): string {
  return JSON.stringify({
    checkerName: identity.checkerName,
    configPath: normalizeAbsolutePathIdentity(identity.configPath),
    generation: identity.generation,
    preset: identity.preset,
    versionTuple: identity.versionTuple ?? [],
  });
}

export function createImportTypeEvidenceCacheKey(options: {
  importRecord: ImportRecord;
  providerKey: string;
}): string {
  return JSON.stringify({
    filePath: normalizeAbsolutePathIdentity(options.importRecord.filePath),
    kind: options.importRecord.kind,
    locator: options.importRecord.locator,
    providerKey: options.providerKey,
    specifier: options.importRecord.specifier,
  });
}

export class TypeEvidenceGenerationCache {
  readonly ambientSymbolLookupCache: AmbientSymbolLookupCache = new WeakMap();
  readonly importTypeEvidenceCache: ImportTypeEvidenceCache = new Map();
  readonly programCache: ProgramCache = new Map();
  readonly typeEvidenceProviderCache: TypeEvidenceProviderCache = new Map();
  readonly #metrics: TypeEvidenceMetricsRecorder | undefined;
  #disposed = false;

  constructor(metrics?: TypeEvidenceMetricsRecorder) {
    this.#metrics = metrics;

    if (metrics) {
      for (const name of TYPE_EVIDENCE_METRIC_NAMES) {
        metrics.record({ count: 0, name });
      }
    }
  }

  getOrCreateProvider(
    key: string,
    create: () => TypeEvidenceProvider,
    providerName?: string,
  ): TypeEvidenceProvider {
    this.#assertActive();
    const cached = this.typeEvidenceProviderCache.get(key);

    if (cached) {
      this.#metrics?.record({
        name: 'type-evidence-provider-hit',
        provider: providerName,
      });
      return cached;
    }

    const provider = create();

    this.typeEvidenceProviderCache.set(key, provider);
    this.#metrics?.record({
      name: 'type-evidence-provider-create',
      provider: providerName,
    });
    return provider;
  }

  getOrCreateProgram(
    key: string,
    create: () => TypeEvidenceProgramHandle,
    provider?: 'typescript' | 'vue',
  ): TypeEvidenceProgramHandle {
    this.#assertActive();
    const cached = this.programCache.get(key);

    if (cached) {
      return cached;
    }

    const startedAt = performance.now();
    const program = create();

    this.programCache.set(key, program);
    this.#metrics?.record({
      durationMs: Math.max(0, performance.now() - startedAt),
      name: 'program-create-duration',
      provider,
    });
    this.#metrics?.record({
      name:
        provider === 'vue' ? 'vue-program-create' : 'typescript-program-create',
      provider,
    });
    this.#metrics?.record({
      count: program.program.getSourceFiles().length,
      name: 'program-source-file-count',
      provider,
    });
    return program;
  }

  getImportEvidence(key: string): TypeEvidence | undefined {
    this.#assertActive();
    const evidence = this.importTypeEvidenceCache.get(key);

    if (evidence) {
      this.#metrics?.record({ name: 'type-evidence-cache-hit' });
    }

    return evidence;
  }

  setImportEvidence(key: string, evidence: TypeEvidence): void {
    this.#assertActive();
    this.importTypeEvidenceCache.set(key, evidence);
  }

  releaseProviderAndProgram(key: string): void {
    this.#assertActive();
    const provider = this.typeEvidenceProviderCache.get(key);
    const program = this.programCache.get(key);

    provider?.dispose();
    program?.dispose();
    this.typeEvidenceProviderCache.delete(key);
    this.programCache.delete(key);
  }

  getOrCreateAmbientSymbolEvidence(
    symbol: ts.Symbol,
    create: () => TypeEvidence,
  ): TypeEvidence {
    this.#assertActive();
    const cached = this.ambientSymbolLookupCache.get(symbol);

    if (cached) {
      this.#metrics?.record({ name: 'ambient-symbol-hit' });
      return cached;
    }

    this.#metrics?.record({ name: 'ambient-symbol-miss' });
    const evidence = create();

    this.ambientSymbolLookupCache.set(symbol, evidence);
    return evidence;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;

    for (const provider of this.typeEvidenceProviderCache.values()) {
      provider.dispose();
    }

    for (const program of this.programCache.values()) {
      program.dispose();
    }

    this.typeEvidenceProviderCache.clear();
    this.programCache.clear();
    this.importTypeEvidenceCache.clear();
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('Type evidence generation cache has been disposed.');
    }
  }
}
