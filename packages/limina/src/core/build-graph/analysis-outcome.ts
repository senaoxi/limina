import {
  type CoreCollection,
  summarizeCoreCollection,
} from '../../domain/analysis/core-collection';
import type { NativeCollectionStatus } from '../../domain/analysis/native-collection';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import { candidateAdmission } from './analysis-admission';
import { retainNativeAnalysis } from './native-analysis-evidence';
import type { DependencyAnalysisResult } from './types';

export interface AnalysisOutcome {
  readonly core: CoreCollection;
  readonly execution: NativeCollectionStatus['execution'];
  readonly traversal: NativeCollectionStatus['traversal'];
  readonly compilationRelations: NativeCollectionStatus['compilationRelations'];
  readonly graphTransaction: {
    readonly state: 'not-requested' | 'blocked' | 'completed' | 'failed';
    readonly failures: readonly string[];
  };
  readonly governance: {
    readonly scope: 'generated-graph';
    readonly state: 'compliant' | 'violations' | 'unavailable';
    readonly diagnostics: readonly string[];
  };
  readonly buildAdmission: {
    readonly scope: 'generated-graph-materialization';
    readonly state: 'admitted' | 'denied' | 'unavailable';
    readonly reasons: readonly string[];
  };
}

export function finishAnalysisOutcome(
  analysis: DependencyAnalysisResult,
  caches: ProjectDependencyCaches,
  governance: AnalysisOutcome['governance'],
): void {
  retainCollectedEvidence(analysis, caches);
  const core = collectionSummary(analysis, caches);
  const graphTransaction = transactionSummary(analysis, caches, governance);
  const statuses = coreStatuses(analysis, core);
  const compilationRelations = relationSummary(analysis, core, statuses);
  const facts = { core, governance, graphTransaction };
  analysis.outcome = {
    ...facts,
    execution: executionSummary(core),
    traversal: traversalSummary(core, statuses),
    compilationRelations,
    buildAdmission: candidateAdmission(analysis, facts),
  };
  analysis.complete &&= compilationRelations === 'determined';
}

function retainCollectedEvidence(
  analysis: DependencyAnalysisResult,
  caches: ProjectDependencyCaches,
): void {
  retainNativeAnalysis(analysis, caches.nativeSourceEvidence);
  const snapshots = new Set(caches.nativeObservations?.values());
  for (const snapshot of snapshots) retainNativeAnalysis(analysis, snapshot);
  retainCoreFacts(analysis, caches);
}
function retainCoreFacts(
  analysis: DependencyAnalysisResult,
  caches: ProjectDependencyCaches,
): void {
  const facts = caches.coreCollectionRun?.facts ?? [];
  const keys = new Set(analysis.facts.map(relationKey));
  analysis.facts.push(...facts.filter((fact) => !keys.has(relationKey(fact))));
}
function relationKey(fact: DependencyAnalysisResult['facts'][number]): string {
  return JSON.stringify([
    fact.fromConfigPath,
    fact.toConfigPath,
    fact.file,
    fact.specifier,
  ]);
}
function collectionSummary(
  analysis: DependencyAnalysisResult,
  caches: ProjectDependencyCaches,
): CoreCollection {
  const run = caches.coreCollectionRun;
  return run
    ? summarizeCoreCollection({
        closed: run.closed,
        entries: run.work.values().toArray(),
        executionFailureIds: [...run.failureIds],
      })
    : restoredCollection(analysis);
}
function restoredCollection(
  analysis: DependencyAnalysisResult,
): CoreCollection {
  return (
    analysis.outcome?.core ??
    summarizeCoreCollection({
      closed: false,
      entries: [],
      executionFailureIds: [],
    })
  );
}
function priorTransaction(
  analysis: DependencyAnalysisResult,
): AnalysisOutcome['graphTransaction'] {
  return (
    analysis.outcome?.graphTransaction ?? {
      state: 'not-requested',
      failures: [],
    }
  );
}
function transactionSummary(
  analysis: DependencyAnalysisResult,
  caches: ProjectDependencyCaches,
  governance: AnalysisOutcome['governance'],
): AnalysisOutcome['graphTransaction'] {
  const run = caches.coreCollectionRun;
  const transaction = run
    ? { state: run.transaction, failures: [...run.transactionFailures] }
    : priorTransaction(analysis);
  return blockedTransaction(transaction, governance);
}
function blockedTransaction(
  transaction: AnalysisOutcome['graphTransaction'],
  governance: AnalysisOutcome['governance'],
): AnalysisOutcome['graphTransaction'] {
  return governance.state === 'violations' &&
    transaction.state === 'not-requested'
    ? { ...transaction, state: 'blocked' }
    : transaction;
}
function coreStatuses(
  analysis: DependencyAnalysisResult,
  core: CoreCollection,
): NativeCollectionStatus[] {
  const ids = new Set(core.entries.map((entry) => entry.configPath));
  return (analysis.nativeEvidence ?? [])
    .filter((item) =>
      item.snapshot.contexts.some((context) => ids.has(context.inputs.config)),
    )
    .map((item) => item.collection);
}
function executionSummary(core: CoreCollection): AnalysisOutcome['execution'] {
  if (core.executionFailureIds.length > 0)
    return core.entries.some((entry) => entry.execution === 'completed')
      ? 'partial'
      : 'failed';
  return dispatchExecution(core);
}
function dispatchExecution(core: CoreCollection): AnalysisOutcome['execution'] {
  return core.dispatch === 'completed' ? 'completed' : 'partial';
}
function traversalSummary(
  core: CoreCollection,
  statuses: readonly NativeCollectionStatus[],
): AnalysisOutcome['traversal'] {
  const isComplete = [
    core.dispatch === 'completed',
    core.executionFailureIds.length === 0,
    statuses.every((status) => status.traversal === 'complete-within-boundary'),
  ].every(Boolean);
  return isComplete ? 'complete-within-boundary' : 'incomplete';
}
function relationSummary(
  analysis: DependencyAnalysisResult,
  core: CoreCollection,
  statuses: readonly NativeCollectionStatus[],
): AnalysisOutcome['compilationRelations'] {
  const isDetermined = [
    analysis.complete,
    statuses.every((status) => status.compilationRelations === 'determined'),
    core.entries.every((entry) => entry.eligibility === 'eligible'),
  ].every(Boolean);
  return isDetermined ? 'determined' : 'undetermined';
}
