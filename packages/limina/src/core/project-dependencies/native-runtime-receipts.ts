import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import { nativeContextId } from '../analysis-cache/identity';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { ImportRecord } from '../import-analysis/records';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from '../typescript-semantic';
import {
  createImportRecordIdentity,
  isModuleImportRecord,
} from '../typescript-semantic/import-record';
import {
  nativeObservationFailureKind,
  observationErrorDetail,
} from '../typescript-semantic/native-observation-failure';
import type {
  NativeRuntimeModuleQuery,
  NativeRuntimeModuleResult,
} from '../typescript-semantic/runtime-module-queries';
import { matchNativeRuntimeFact } from './native-dependency';

type RuntimeResolution = Pick<
  NativeRuntimeModuleResult,
  'resolvedModule' | 'runtimeMode'
>;
type LiveRuntimeReceipt = { result: RuntimeResolution } | { failure: string };

const liveReceipts = new WeakMap<
  TypeScriptSemanticDependencyContext,
  ReadonlyMap<string, LiveRuntimeReceipt>
>();

export class NativeRuntimeReceipts {
  readonly #cache: NativeAnalysisCache | undefined;
  readonly #contextId: string;
  readonly #configPaths: readonly string[];

  constructor(project: TypeScriptSemanticProject, cache?: NativeAnalysisCache) {
    this.#cache = cache?.supports(project, ts) ? cache : undefined;
    this.#contextId = nativeContextId({
      ...project,
      compilationObligationScope: undefined,
    });
    const owner = project.sourceConfigPath ?? project.configPath;
    this.#configPaths = [
      ...(this.#cache?.configClosures.get(owner) ?? []),
      owner,
      project.configPath,
    ];
  }

  resolve(
    record: ImportRecord,
    explicitMode: ts.ResolutionMode,
    prepare: () => ReturnType<NativeRuntimeModuleQuery>,
    context: TypeScriptSemanticDependencyContext,
  ): RuntimeResolution {
    const identity = createImportRecordIdentity(record);
    const prior = liveReceipts.get(context)?.get(identity);
    if (prior !== undefined) {
      if ('failure' in prior) throw new Error(prior.failure);
      return prior.result;
    }
    if (this.#cache === undefined) {
      const prepared = prepare();
      return prepared.resolve(prepared.host);
    }
    return this.#cache.queryRuntime<NativeRuntimeModuleResult>({
      contextId: this.#contextId,
      file: normalizeAbsolutePath(record.filePath),
      identity: ['bounded-runtime-module-v1', identity, explicitMode ?? null],
      configPaths: this.#configPaths,
      observeSource: true,
      prepare,
    });
  }
}

export function retainLiveNativeRuntimeReceipts(options: {
  context: TypeScriptSemanticDependencyContext;
  query: NativeRuntimeModuleQuery;
  project: TypeScriptSemanticProject;
  files: readonly string[];
  cache?: NativeAnalysisCache;
}): void {
  const { context, query, project, files, cache } = options;
  const resolved = new Map<string, LiveRuntimeReceipt>();
  const receipts = new NativeRuntimeReceipts(project, cache);
  for (const file of files) {
    const syntax = context.getFileDependencyFacts?.(file);
    if (syntax === undefined) continue;
    for (const {
      occurrence,
      explicitMode,
      externalModuleOnly,
    } of syntax.requests) {
      if (
        externalModuleOnly ||
        !isModuleImportRecord(occurrence) ||
        matchNativeRuntimeFact(context, occurrence) !== undefined
      )
        continue;
      const identity = createImportRecordIdentity(occurrence);
      try {
        const { resolvedModule, runtimeMode } = receipts.resolve(
          occurrence,
          explicitMode,
          () => query(occurrence, explicitMode),
          context,
        );
        resolved.set(identity, { result: { resolvedModule, runtimeMode } });
      } catch (error) {
        if (nativeObservationFailureKind(error) === 'input-drift') throw error;
        resolved.set(identity, { failure: observationErrorDetail(error) });
      }
    }
  }
  liveReceipts.set(context, resolved);
}
