import type { ImportRecord } from '#core/import-analysis/runner';
import { compareCodeUnits } from '#utils/collections';
import type ts from 'typescript';
import { createAmbientTypeEvidence } from './ambient-symbol';
import type {
  TypeEvidence,
  TypeEvidenceGenerationCache,
  TypeEvidenceProvider,
} from './cache';
import type { TypeScriptTypeEvidenceProject } from './typescript-provider';
import { collectVueModuleLiterals } from './vue-literals';
import { createVueProgramHandle } from './vue-program';
import type {
  SupportedVueTypeEvidenceCapability,
  VueProgramHandle,
} from './vue-provider-types';

interface VueEvidenceProviderOptions {
  cache: TypeEvidenceGenerationCache;
  capability: SupportedVueTypeEvidenceCapability;
  checkerName: string;
  programKey: string;
  project: TypeScriptTypeEvidenceProject;
}

interface VueEvidenceProviderState {
  disposed: boolean;
  options: VueEvidenceProviderOptions;
  unsupportedReason: string | null;
}

type ProgramResolution =
  | { handle: VueProgramHandle; kind: 'supported' }
  | { evidence: TypeEvidence; kind: 'unsupported' };

function createUnsupportedEvidence(
  checker: string,
  reason: string,
): TypeEvidence {
  return { checker, kind: 'unsupported-checker', reason };
}

function formatInitializationFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Vue Language Service initialization failed: ${message}`;
}

function resolveProgram(state: VueEvidenceProviderState): ProgramResolution {
  try {
    const handle = state.options.cache.getOrCreateProgram(
      state.options.programKey,
      () => createVueProgramHandle(state.options),
      'vue',
    ) as VueProgramHandle;
    return { handle, kind: 'supported' };
  } catch (error) {
    state.unsupportedReason = formatInitializationFailure(error);
    return {
      evidence: createUnsupportedEvidence(
        state.options.checkerName,
        state.unsupportedReason,
      ),
      kind: 'unsupported',
    };
  }
}

function createLiteralEvidence(options: {
  cache: TypeEvidenceGenerationCache;
  handle: VueProgramHandle;
  literal: ts.StringLiteralLike;
}): TypeEvidence {
  const symbol = options.handle.program
    .getTypeChecker()
    .getSymbolAtLocation(options.literal);
  if (symbol === undefined) {
    return { kind: 'missing' };
  }
  return options.cache.getOrCreateAmbientSymbolEvidence(symbol, () =>
    createAmbientTypeEvidence(symbol),
  );
}

function canonicalAmbientIdentity(evidence: TypeEvidence): string | null {
  if (evidence.kind !== 'ambient') {
    return null;
  }
  return JSON.stringify([
    evidence.modulePattern,
    [...evidence.declarationFilePaths].sort(compareCodeUnits),
  ]);
}

function allEvidenceMissing(evidence: readonly TypeEvidence[]): boolean {
  return evidence.every((item) => item.kind === 'missing');
}

function hasOneAmbientIdentity(evidence: readonly TypeEvidence[]): boolean {
  const identities = evidence.map(canonicalAmbientIdentity);
  const firstIdentity = identities[0];
  return (
    firstIdentity !== null &&
    firstIdentity !== undefined &&
    identities.every((identity) => identity === firstIdentity)
  );
}

function selectCanonicalEvidence(options: {
  checkerName: string;
  evidence: readonly TypeEvidence[];
}): TypeEvidence {
  if (allEvidenceMissing(options.evidence)) {
    return { kind: 'missing' };
  }
  if (hasOneAmbientIdentity(options.evidence)) {
    return options.evidence[0]!;
  }
  return createUnsupportedEvidence(
    options.checkerName,
    'Vue source-map candidates did not agree on one canonical ambient module symbol.',
  );
}

function evaluateLiterals(options: {
  handle: VueProgramHandle;
  importRecord: ImportRecord;
  state: VueEvidenceProviderState;
}): TypeEvidence {
  const literals = collectVueModuleLiterals({
    handle: options.handle,
    importRecord: options.importRecord,
  });
  if (literals === null || literals.length === 0) {
    return createUnsupportedEvidence(
      options.state.options.checkerName,
      'Vue source-map locator did not resolve to a unique virtual module literal set.',
    );
  }
  return selectCanonicalEvidence({
    checkerName: options.state.options.checkerName,
    evidence: literals.map((literal) =>
      createLiteralEvidence({
        cache: options.state.options.cache,
        handle: options.handle,
        literal,
      }),
    ),
  });
}

function assertProviderActive(state: VueEvidenceProviderState): void {
  if (state.disposed) {
    throw new Error('Vue type-evidence provider was disposed.');
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
  const program = resolveProgram(state);
  return program.kind === 'unsupported'
    ? program.evidence
    : evaluateLiterals({ handle: program.handle, importRecord, state });
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
      state.disposed = true;
    },
    query: ({ importRecord }) => {
      assertProviderActive(state);
      return queryActiveProvider(state, importRecord);
    },
  };
}
