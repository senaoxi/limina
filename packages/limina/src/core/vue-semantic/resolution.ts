import type {
  ResolvedCheckerModuleName,
  VueProjectSemanticIdentity,
} from '#checkers';
import type { ImportRecord } from '#core/import-analysis/runner';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { FrameworkSemanticFailureStage } from '../framework-semantic/contracts';
import type { VueSemanticContextManager } from './context';
import {
  collectSemanticDependencyEvidence,
  type SemanticDependencyEvidence,
} from './dependency';

interface ResolvedSemanticCandidate {
  evidence: SemanticDependencyEvidence;
  mode: string;
  resolution: ResolvedCheckerModuleName | null;
}

export type VueSemanticResolution =
  | {
      evidence: SemanticDependencyEvidence;
      kind: 'resolved';
      resolutionMode: string;
      resolution: ResolvedCheckerModuleName | null;
    }
  | {
      kind: 'unsupported';
      reason: string;
      stage: FrameworkSemanticFailureStage;
    };

interface TypeScriptModeApi {
  getModeForUsageLocation(
    sourceFile: ts.SourceFile,
    literal: ts.StringLiteralLike,
    compilerOptions: ts.CompilerOptions,
  ): unknown;
}

function getResolutionMode(options: {
  compilerOptions: ts.CompilerOptions;
  evidence: SemanticDependencyEvidence;
  tsModule: typeof ts;
}): string {
  const api = options.tsModule as typeof ts & Partial<TypeScriptModeApi>;
  if (typeof api.getModeForUsageLocation !== 'function') {
    return 'default';
  }
  return String(
    api.getModeForUsageLocation(
      options.evidence.containingSourceFile,
      options.evidence.literal,
      options.compilerOptions,
    ),
  );
}

function isCheckerSource(options: {
  fileName: string;
  identity: VueProjectSemanticIdentity;
}): boolean {
  const normalized = normalizeAbsolutePath(options.fileName);
  return options.identity.profilesByFileName.has(normalized);
}

function createCheckerResolution(options: {
  identity: VueProjectSemanticIdentity;
  resolvedModule: ts.ResolvedModuleFull;
}): ResolvedCheckerModuleName {
  const resolvedFileName = normalizeAbsolutePath(
    options.resolvedModule.resolvedFileName,
  );
  return {
    isExternalLibraryImport:
      options.resolvedModule.isExternalLibraryImport === true,
    resolvedBy: isCheckerSource({
      fileName: resolvedFileName,
      identity: options.identity,
    })
      ? 'checker-source'
      : 'typescript',
    resolvedFileName,
  };
}

function canonicalCandidate(candidate: ResolvedSemanticCandidate): string {
  return JSON.stringify([
    candidate.evidence.semanticSpecifier,
    candidate.mode,
    getResolutionValue(candidate.resolution, 'resolvedFileName'),
    getResolutionValue(candidate.resolution, 'resolvedBy'),
  ]);
}

function getResolutionValue(
  resolution: ResolvedCheckerModuleName | null,
  key: 'resolvedBy' | 'resolvedFileName',
): string | null {
  if (resolution === null) return null;
  return resolution[key];
}

function selectCanonicalCandidate(
  candidates: readonly ResolvedSemanticCandidate[],
): VueSemanticResolution {
  const first = candidates[0];
  if (first === undefined) {
    return {
      kind: 'unsupported',
      reason: 'Vue semantic dependency did not resolve to a module target.',
      stage: 'source-map-mismatch',
    };
  }
  const identity = canonicalCandidate(first);
  if (
    !candidates.every((candidate) => canonicalCandidate(candidate) === identity)
  ) {
    return {
      kind: 'unsupported',
      reason:
        'Vue source-map candidates did not agree on semantic specifier, resolution mode, and normalized target.',
      stage: 'source-map-mismatch',
    };
  }
  return {
    evidence: first.evidence,
    kind: 'resolved',
    resolutionMode: first.mode,
    resolution: first.resolution,
  };
}

export function resolveVueSemanticImport(options: {
  identity: VueProjectSemanticIdentity;
  importRecord: ImportRecord;
  manager: VueSemanticContextManager;
}): VueSemanticResolution {
  try {
    const context = options.manager.acquire(options.identity);
    return resolveWithContext({ ...options, context });
  } catch (error) {
    return {
      kind: 'unsupported',
      reason: formatResolutionError(error),
      stage: 'context-creation',
    };
  }
}

function createResolvedCandidate(options: {
  context: ReturnType<VueSemanticContextManager['acquire']>;
  evidence: SemanticDependencyEvidence;
  identity: VueProjectSemanticIdentity;
  resolvedByLiteral: ReadonlyMap<
    ts.StringLiteralLike,
    ts.ResolvedModuleWithFailedLookupLocations
  >;
}): ResolvedSemanticCandidate {
  const resolvedModule = options.resolvedByLiteral.get(
    options.evidence.literal,
  )?.resolvedModule;
  const resolution =
    resolvedModule === undefined
      ? null
      : createCheckerResolution({
          identity: options.identity,
          resolvedModule,
        });
  return {
    evidence: options.evidence,
    mode: getResolutionMode({
      compilerOptions: options.identity.options,
      evidence: options.evidence,
      tsModule: options.context.tsModule,
    }),
    resolution,
  };
}

function resolveWithContext(options: {
  context: ReturnType<VueSemanticContextManager['acquire']>;
  identity: VueProjectSemanticIdentity;
  importRecord: ImportRecord;
}): VueSemanticResolution {
  const dependency = collectSemanticDependencyEvidence({
    context: options.context,
    importRecord: options.importRecord,
  });
  if (dependency.kind === 'unsupported') {
    return {
      ...dependency,
      stage: 'source-map-mismatch',
    };
  }
  const resolvedByLiteral = options.context.resolveModuleNameLiterals(
    dependency.candidates.map((candidate) => candidate.literal),
  );
  return selectCanonicalCandidate(
    dependency.candidates.map((evidence) =>
      createResolvedCandidate({ ...options, evidence, resolvedByLiteral }),
    ),
  );
}

function formatResolutionError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
