import { LiminaStructuredError } from '../../check-reporting/errors';
import { TypeScriptConfigInputError } from '../../checker/project-base';
import type {
  NativeEvidenceFailure,
  NativeEvidenceSnapshot,
} from '../../domain/analysis/native-evidence';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import type {
  ProjectDependencyCaches,
  ProjectDependencyFailure,
} from '../project-dependencies/contracts';
import { retainNativeObservation } from '../project-dependencies/native-evidence-retention';
import { TsconfigInputError } from '../tsconfig/config-paths';
import { collectNativeEvidence } from '../typescript-semantic/native-evidence-collection';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import {
  NativeObservationError,
  nativeObservationFailureKind,
  observationErrorDetail,
} from '../typescript-semantic/native-observation-failure';
import { CandidateAdmissionUnavailable } from './analysis-admission';
import type { AnalysisOutcome } from './analysis-outcome';
import { finishAnalysisOutcome } from './analysis-outcome';
import { coreCollectionRun } from './core-collection-run';
import type { DependencyAnalysisResult } from './types';

class GraphPreparationError extends Error {
  readonly analysis: DependencyAnalysisResult;
  override readonly cause: unknown;
  constructor(error: unknown, analysis: DependencyAnalysisResult) {
    super(observationErrorDetail(error));
    this.cause = error;
    this.analysis = analysis;
  }
}

class GovernedGraphPreparationError extends LiminaStructuredError {
  readonly analysis: DependencyAnalysisResult;
  override readonly cause: unknown;
  constructor(
    error: LiminaStructuredError,
    analysis: DependencyAnalysisResult,
  ) {
    super(error.message, []);
    this.issues.push(...error.issues);
    this.cause = error;
    this.analysis = analysis;
  }
}

export function createGraphPreparationError(
  error: unknown,
  analysis: DependencyAnalysisResult,
): Error & { readonly analysis: DependencyAnalysisResult } {
  return error instanceof LiminaStructuredError
    ? new GovernedGraphPreparationError(error, analysis)
    : new GraphPreparationError(error, analysis);
}

export function failedGraphAnalysis(
  error: unknown,
  analysis: DependencyAnalysisResult,
  caches: ProjectDependencyCaches,
): DependencyAnalysisResult {
  if (isUnretainedFailure(error)) retainAnalysisFailure(caches, error);
  retainBlockedTransaction(caches, error);
  analysis.complete = false;
  analysis.declarationContexts ??=
    caches.coreCollectionRun?.declarationContexts;
  analysis.diagnostics.push(observationErrorDetail(error));
  finishAnalysisOutcome(analysis, caches, failedGovernance(error, analysis));
  return analysis;
}

function failedGovernance(
  error: unknown,
  analysis: DependencyAnalysisResult,
): AnalysisOutcome['governance'] {
  return analysis.outcome === undefined
    ? initialGovernance(error)
    : analysis.outcome.governance;
}

function initialGovernance(error: unknown): AnalysisOutcome['governance'] {
  const hasViolation = error instanceof LiminaStructuredError;
  return {
    scope: 'generated-graph',
    state: hasViolation ? 'violations' : 'unavailable',
    diagnostics: hasViolation ? [observationErrorDetail(error)] : [],
  };
}

export function retainAnalysisFailure(
  caches: ProjectDependencyCaches,
  error: unknown,
  configPath?: string,
): void {
  const detail = observationErrorDetail(error);
  const run = coreCollectionRun(caches);
  if (run.closed) {
    run.transaction = 'failed';
    run.transactionFailures.push(detail);
    return;
  }
  const coverage = caches.sourceConfigCoverage;
  const enumeration = coverage?.configurations.find(
    (config) => config.configId === configPath,
  );
  const id =
    enumeration?.state === 'failed'
      ? enumeration.failureId
      : nativeFingerprint([configPath, detail]);
  run.failureIds.add(id);
  const snapshot = freezeNativeData({
    ...collectNativeEvidence([]),
    run: 'failed' as const,
    coverageIndexes: coverage ? [coverage] : [],
    failures: [
      {
        id,
        detail,
        kind: failureKind(error),
        evidenceIds: configPath === undefined ? [] : [configPath],
        affected: affectedScope(caches, configPath),
      },
    ],
  });
  retainNativeObservation(caches, snapshot);
}

function failureKind(error: unknown) {
  return [TypeScriptConfigInputError, TsconfigInputError].some(
    (Type) => error instanceof Type,
  )
    ? ('config-parse' as const)
    : nativeObservationFailureKind(error);
}

function affectedScope(
  caches: ProjectDependencyCaches,
  configPath: string | undefined,
): NativeEvidenceFailure['affected'] {
  const ids = new Set<string>();
  const observations = caches.nativeObservations?.values() ?? [];
  for (const snapshot of observations) {
    for (const context of snapshot.contexts) {
      if ((context.inputs.sourceConfig ?? context.inputs.config) === configPath)
        ids.add(context.id);
    }
  }
  return ids.size > 0
    ? { kind: 'contexts', contextIds: [...ids] }
    : {
        kind: 'universe',
        universeId:
          caches.sourceConfigCoverage?.universe.id ??
          'unavailable-source-universe',
      };
}

export function retainDependencyFailure(
  caches: ProjectDependencyCaches,
  failure: ProjectDependencyFailure,
  detail: string,
): void {
  retainAnalysisFailure(
    caches,
    new NativeObservationError(dependencyFailureKind(failure), detail),
    failure.configPath,
  );
}

function dependencyFailureKind(
  failure: ProjectDependencyFailure,
): NativeEvidenceFailure['kind'] {
  if (failure.stage === 'toolchain-compatibility') return 'unsupported';
  return [
    'toolchain-resolution',
    'project-materialization',
    'generated-script-materialization',
  ].includes(failure.stage)
    ? 'compiler-initialization'
    : 'internal';
}

function isUnretainedFailure(error: unknown): boolean {
  return [
    LiminaStructuredError,
    CollectedAnalysisFailure,
    CandidateAdmissionUnavailable,
  ].every((Type) => !(error instanceof Type));
}
function retainBlockedTransaction(
  caches: ProjectDependencyCaches,
  error: unknown,
): void {
  if (
    isBlockedTransaction(error) &&
    coreCollectionRun(caches).transaction !== 'failed'
  )
    coreCollectionRun(caches).transaction = 'blocked';
}

class CollectedAnalysisFailure extends Error {
  constructor(details: readonly string[]) {
    super([...new Set(details)].join('\n\n'));
    this.name = 'CollectedAnalysisFailure';
  }
}
export function assertCollectedExecution(
  caches: ProjectDependencyCaches | undefined,
): void {
  if (caches === undefined) return;
  if (coreCollectionRun(caches).failureIds.size > 0)
    throw new CollectedAnalysisFailure(collectedFailureDetails(caches));
}
function collectedFailureDetails(caches: ProjectDependencyCaches): string[] {
  return cachedFailureSnapshots(caches).flatMap((snapshot) =>
    snapshot.failures.map((failure) => failure.detail),
  );
}
function isBlockedTransaction(error: unknown): boolean {
  return [
    LiminaStructuredError,
    CollectedAnalysisFailure,
    CandidateAdmissionUnavailable,
  ].some((Type) => error instanceof Type);
}

function cachedFailureSnapshots(
  caches: ProjectDependencyCaches,
): NativeEvidenceSnapshot[] {
  return [...(caches.nativeObservations?.values() ?? [])];
}
