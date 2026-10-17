import type { ImportRecord } from '#core/import-analysis/runner';
import { occurrenceKey } from '../analysis-cache/semantic-state';
import type { VueSemanticContextManager } from '../vue-semantic/context';
import { observeVueDependency } from '../vue-semantic/dependency-observation';
import type {
  TypeEvidence,
  TypeEvidenceGenerationCache,
  TypeEvidenceProvider,
} from './cache';
import type { SupportedVueTypeEvidenceCapability } from './vue-provider-types';

interface VueEvidenceProviderOptions {
  cache: TypeEvidenceGenerationCache;
  capability: SupportedVueTypeEvidenceCapability;
  checkerName: string;
  contexts: VueSemanticContextManager;
}

interface VueEvidenceProviderState {
  disposed: boolean;
  options: VueEvidenceProviderOptions;
  unsupportedReason: string | null;
}

function createUnsupportedEvidence(
  checker: string,
  reason: string,
): TypeEvidence {
  return { checker, kind: 'unsupported-checker', reason };
}

function formatProviderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function querySemanticProvider(
  state: VueEvidenceProviderState,
  importRecord: ImportRecord,
): TypeEvidence {
  const context = state.options.contexts.acquire(
    state.options.capability.identity,
  );
  return observeVueDependency({ context, importRecord, target: null })
    .typeEvidence;
}

function queryProviderSafely(
  state: VueEvidenceProviderState,
  importRecord: ImportRecord,
): TypeEvidence {
  try {
    return querySemanticProvider(state, importRecord);
  } catch (error) {
    const reason = `Vue Language Service initialization failed: ${formatProviderError(error)}`;
    state.unsupportedReason = reason;
    return createUnsupportedEvidence(state.options.checkerName, reason);
  }
}

function queryActiveProvider(
  state: VueEvidenceProviderState,
  importRecord: ImportRecord,
): TypeEvidence {
  return state.unsupportedReason === null
    ? queryProviderSafely(state, importRecord)
    : createUnsupportedEvidence(
        state.options.checkerName,
        state.unsupportedReason,
      );
}

function queryPersistentProvider(
  state: VueEvidenceProviderState,
  importRecord: ImportRecord,
): TypeEvidence {
  let result: TypeEvidence | undefined;
  const restored = state.options.contexts.query({
    identity: state.options.capability.identity,
    kind: 'evidence',
    request: [
      importRecord.filePath,
      importRecord.line,
      occurrenceKey(importRecord),
    ],
    collect: () => {
      result = queryActiveProvider(state, importRecord);
      return result.kind === 'unsupported-checker' ? undefined : result;
    },
  });
  return restored ?? result!;
}

export function createVueTypeEvidenceProvider(
  options: VueEvidenceProviderOptions,
): TypeEvidenceProvider {
  const state: VueEvidenceProviderState = {
    disposed: false,
    options,
    unsupportedReason: null,
  };
  return {
    dispose: () => {
      if (state.disposed) return;
      state.disposed = true;
      state.options.contexts.release(state.options.capability.identity);
    },
    query: ({ importRecord }) => {
      if (state.disposed) {
        throw new Error('Vue type-evidence provider was disposed.');
      }
      return queryPersistentProvider(state, importRecord);
    },
  };
}
