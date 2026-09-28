import type { ImportRecord } from '#core/import-analysis/runner';
import { compareCodeUnits } from '#utils/collections';
import type ts from 'typescript';
import type {
  VueSemanticContext,
  VueSemanticContextManager,
} from '../vue-semantic/context';
import {
  collectSemanticDependencyEvidence,
  type SemanticDependencyEvidence,
} from '../vue-semantic/dependency';
import { createAmbientTypeEvidence } from './ambient-symbol';
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

function createLiteralEvidence(options: {
  cache: TypeEvidenceGenerationCache;
  context: VueSemanticContext;
  literal: ts.StringLiteralLike;
}): TypeEvidence {
  const symbol = options.context.program
    .getTypeChecker()
    .getSymbolAtLocation(options.literal);
  if (symbol === undefined) return { kind: 'missing' };
  return options.cache.getOrCreateAmbientSymbolEvidence(symbol, () =>
    createAmbientTypeEvidence(symbol, options.context.tsModule),
  );
}

function canonicalAmbientIdentity(evidence: TypeEvidence): string | null {
  if (evidence.kind !== 'ambient') return null;
  return JSON.stringify([
    evidence.modulePattern,
    [...evidence.declarationFilePaths].sort(compareCodeUnits),
  ]);
}

function hasCanonicalIdentity(
  identities: readonly (string | null)[],
  firstIdentity: string | null | undefined,
): boolean {
  return [
    firstIdentity !== null,
    firstIdentity !== undefined,
    identities.every((identity) => identity === firstIdentity),
  ].every(Boolean);
}

function selectCanonicalEvidence(options: {
  checkerName: string;
  evidence: readonly TypeEvidence[];
}): TypeEvidence {
  if (options.evidence.every((item) => item.kind === 'missing')) {
    return { kind: 'missing' };
  }
  const identities = options.evidence.map(canonicalAmbientIdentity);
  const firstIdentity = identities[0];
  if (hasCanonicalIdentity(identities, firstIdentity)) {
    return options.evidence[0]!;
  }
  return createUnsupportedEvidence(
    options.checkerName,
    'Vue source-map candidates did not agree on one canonical ambient module symbol.',
  );
}

function evaluateEvidence(options: {
  context: VueSemanticContext;
  evidence: readonly SemanticDependencyEvidence[];
  state: VueEvidenceProviderState;
}): TypeEvidence {
  return selectCanonicalEvidence({
    checkerName: options.state.options.checkerName,
    evidence: options.evidence.map((candidate) =>
      createLiteralEvidence({
        cache: options.state.options.cache,
        context: options.context,
        literal: candidate.literal,
      }),
    ),
  });
}

function formatProviderError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function querySemanticProvider(
  state: VueEvidenceProviderState,
  importRecord: ImportRecord,
): TypeEvidence {
  const context = state.options.contexts.acquire(
    state.options.capability.identity,
  );
  const dependency = collectSemanticDependencyEvidence({
    context,
    importRecord,
  });
  if (dependency.kind === 'unsupported') {
    return createUnsupportedEvidence(
      state.options.checkerName,
      dependency.reason,
    );
  }
  return evaluateEvidence({
    context,
    evidence: dependency.candidates,
    state,
  });
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
  if (state.unsupportedReason !== null) {
    return createUnsupportedEvidence(
      state.options.checkerName,
      state.unsupportedReason,
    );
  }
  return queryProviderSafely(state, importRecord);
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
      return queryActiveProvider(state, importRecord);
    },
  };
}
