import type { VueProjectSemanticIdentity } from '#checkers';
import type ts from 'typescript';
import { vueCompilerPathPolicy } from '../../checker/vue-semantic-identity';
import { deriveCompilerCoverage } from '../typescript-semantic/compiler-coverage';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import { observeNativeFileIdentity } from '../typescript-semantic/native-file-identity';
import { analysisHash } from './identity';
import type { NativeAnalysisCache } from './native-cache';
import { recordCacheHit, recordCacheMiss } from './profile-decisions';
import type { VueContextRecord, VueModuleRecord } from './vue-contracts';
import { bindVueExecutionInputs } from './vue-execution-inputs';
import type { VueInputTrace } from './vue-inputs';
import {
  decodeVueModuleResult,
  encodeVueModuleResult,
  type ModuleResult,
} from './vue-module-result';

type VolarResolutionHost = ts.LanguageServiceHost & {
  getModuleResolutionCache?(): ts.ModuleResolutionCache;
};

export class VueModuleReplay {
  readonly #previous: VueContextRecord | undefined;
  readonly #restored = new WeakSet<ModuleResult>();

  readonly #trace: VueInputTrace;
  readonly #cache: NativeAnalysisCache;
  readonly #identity: VueProjectSemanticIdentity;
  readonly #fileKey: (file: string) => string;
  readonly #owners = new Map<string, string[] | null>();
  readonly #options = new WeakMap<ts.CompilerOptions, string>();
  readonly records: Record<string, VueModuleRecord>;

  constructor(options: {
    cache: NativeAnalysisCache;
    identity: VueProjectSemanticIdentity;
    trace: VueInputTrace;
    previous?: VueContextRecord;
    restored: boolean;
  }) {
    this.#cache = options.cache;
    this.#identity = options.identity;
    this.#fileKey = vueCompilerPathPolicy(options.identity).key;
    this.#trace = options.trace;
    this.#previous = options.previous;
    this.records = options.restored
      ? { ...options.previous?.moduleResolutions }
      : {};
  }

  #optionsId(options: ts.CompilerOptions): string {
    let id = this.#options.get(options);
    if (id === undefined) {
      id = analysisHash(effectiveCompilerOptions(options));
      this.#options.set(options, id);
    }
    return id;
  }

  #inspectOwners(target: string): string[] | null {
    const index = this.#identity.declarationLoading?.coverage;
    if (index === undefined) return null;
    const physical = observeNativeFileIdentity(target, index.inputVersion);
    const coverage = deriveCompilerCoverage(index, physical, this.#fileKey);
    return coverage.completeness === 'complete' &&
      (coverage.state === 'unique' || coverage.state === 'uncovered')
      ? coverage.members.map((member) => member.configId)
      : null;
  }

  #targetOwners(result: ModuleResult): string[] | null {
    const target = result.resolvedModule?.resolvedFileName;
    if (target === undefined) return [];
    const prior = this.#owners.get(target);
    if (prior !== undefined) return prior;
    const owners = this.#inspectOwners(target);
    this.#owners.set(target, owners);
    return owners;
  }

  #restore(id: string, file: string): ModuleResult | undefined {
    const current = this.records[id];
    const record = current ?? this.#previous?.moduleResolutions[id];
    if (record === undefined) {
      recordCacheMiss('vue-resolution', 'vue-resolution-record-absent', {
        file,
        absent: true,
      });
      return undefined;
    }
    if (this.#cache.inputs.toolchainChanged) {
      recordCacheMiss('vue-resolution', 'toolchain-input-changed', { file });
      return undefined;
    }
    const stale = record.dependencies.find(
      (dependency) => !this.#cache.inputs.valid(dependency),
    );
    if (stale !== undefined) {
      const inputs = this.#cache.inputs;
      const input =
        inputs.records[stale.inputId] ?? inputs.previous[stale.inputId];
      recordCacheMiss('vue-resolution', 'vue-resolution-input-stale', {
        file,
        input:
          input === undefined
            ? undefined
            : { kind: input.kind, file: input.path },
      });
      return undefined;
    }
    const result = decodeVueModuleResult(record.result);
    if (result === undefined) {
      recordCacheMiss('vue-resolution', 'vue-resolution-payload-invalid', {
        file,
      });
      return undefined;
    }
    const owners = this.#targetOwners(result);
    if (owners === null || record.targetOwners === null) {
      recordCacheMiss(
        'vue-resolution',
        'vue-resolution-target-ownership-unknown',
        { file },
      );
      return undefined;
    }
    if (
      owners.length !== record.targetOwners.length ||
      owners[0] !== record.targetOwners[0]
    ) {
      this.#cache.increment('vueModuleOwnerMisses');
      recordCacheMiss(
        'vue-resolution',
        'vue-resolution-target-ownership-changed',
        { file },
      );
      return undefined;
    }
    this.#cache.increment('vueModuleResolutionHits');
    recordCacheHit(
      'vue-resolution',
      record === this.#previous?.moduleResolutions[id]
        ? this.#cache.previousOrigin
        : 'invocation-memory',
      file,
    );
    if (record === this.#previous?.moduleResolutions[id])
      this.#restored.add(result);
    if (current !== undefined) return result;
    this.#trace.retainResolution(record.dependencies, record.members);
    bindVueExecutionInputs(
      this.#identity,
      this.#cache.inputs,
      record.dependencies,
      this.#cache.configReads.replay(),
    );
    this.records[id] = record;
    this.#cache.increment('restoredVueModuleResolutions');
    return result;
  }

  #query(options: {
    id: string;
    file: string;
    clear: () => void;
    collect: () => ModuleResult;
  }): ModuleResult {
    const restored = this.#restore(options.id, options.file);
    if (restored !== undefined) return restored;

    // A Volar/TypeScript memo hit omits probes used to choose synthetic
    // extension candidates. Capture every decision at a genuine resolver miss.
    options.clear();
    this.#cache.increment('vueModuleResolutions');
    const { result, trace, members } = this.#trace.collectResolution(() => {
      this.#trace.add(options.file, 'content');
      this.#trace.add(options.file, 'binding');
      return options.collect();
    });
    trace.raw(result);
    this.#trace.complete &&= trace.complete;
    const dependencies = trace.dependencies.values().toArray();
    this.#trace.retainResolution(dependencies, members);
    const encoded = trace.complete ? encodeVueModuleResult(result) : undefined;
    if (encoded !== undefined)
      this.records[options.id] = {
        members,
        dependencies,
        result: encoded,
        targetOwners: this.#targetOwners(result),
      };
    return result;
  }

  wasRestored(result: ModuleResult): boolean {
    return this.#restored.has(result);
  }

  wrap(host: VolarResolutionHost): void {
    const resolver = host.resolveModuleNameLiterals?.bind(host);
    const cache = host.getModuleResolutionCache?.();
    if (resolver === undefined || cache === undefined) return;

    let isSeeded = false;
    host.resolveModuleNameLiterals = (
      literals,
      file,
      redirect,
      options,
      source,
      reused,
    ) => {
      if (redirect !== undefined || (reused?.length ?? 0) > 0)
        return resolver(literals, file, redirect, options, source, reused);
      if (!isSeeded) {
        host.getScriptFileNames();
        isSeeded = true;
      }
      const optionsId = this.#optionsId(options);
      return literals.map((literal) => {
        const id = analysisHash([
          file,
          source.impliedNodeFormat,
          literal.pos,
          literal.end,
          literal.text,
          literal.parent?.kind,
          optionsId,
        ]);
        return this.#query({
          id,
          file,
          clear: () => cache.clear(),
          collect: () =>
            resolver([literal], file, redirect, options, source, reused)[0]!,
        });
      });
    };
  }
}
