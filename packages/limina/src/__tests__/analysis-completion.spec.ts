import { describe, expect, it } from 'vitest';
import { candidateAdmission } from '../core/build-graph/analysis-admission';
import { retainAnalysisFailure } from '../core/build-graph/analysis-failure';
import { finishAnalysisOutcome } from '../core/build-graph/analysis-outcome';
import {
  beginCoreCollection,
  coreCollectionRun,
  recordCoreWork,
} from '../core/build-graph/core-collection-run';
import type { DependencyAnalysisResult } from '../core/build-graph/types';
import { createProjectDependencyCaches } from '../core/project-dependencies/cache';
import {
  type CoreWorkItem,
  summarizeCoreCollection,
} from '../domain/analysis/core-collection';

const item: CoreWorkItem = {
  id: 'a',
  configPath: 'A',
  phase: 'locked',
  family: 'typescript',
  eligibility: 'eligible',
  execution: 'completed',
};
const governance = {
  scope: 'generated-graph' as const,
  state: 'compliant' as const,
  diagnostics: [],
};
const transaction = { state: 'not-requested' as const, failures: [] };
const analysis = (): DependencyAnalysisResult => ({
  complete: true,
  diagnostics: [],
  facts: [],
  candidate: { configPaths: ['A'], references: [], schedules: [] },
});

describe('Core scheduling and candidate admission', () => {
  it('completes all eligible work with an unavailable independent authority', () => {
    const core = summarizeCoreCollection({
      closed: true,
      entries: [
        item,
        {
          ...item,
          id: 'b',
          configPath: 'B',
          eligibility: 'unavailable',
          execution: 'not-run',
        },
      ],
      executionFailureIds: [],
    });
    expect(core.dispatch).toBe('completed');
    expect(
      candidateAdmission(analysis(), {
        core,
        governance,
        graphTransaction: transaction,
      }).state,
    ).toBe('admitted');
    const needsB = analysis();
    needsB.candidate = {
      configPaths: ['A', 'B'],
      references: [],
      schedules: [],
    };
    expect(
      candidateAdmission(needsB, {
        core,
        governance,
        graphTransaction: transaction,
      }).state,
    ).toBe('unavailable');
  });
  it('cannot claim complete when governance skips an eligible entry', () => {
    const core = summarizeCoreCollection({
      closed: true,
      entries: [{ ...item, execution: 'not-run' }],
      executionFailureIds: [],
    });
    expect(core.dispatch).toBe('incomplete');
    expect(
      candidateAdmission(analysis(), {
        core,
        governance,
        graphTransaction: transaction,
      }).state,
    ).toBe('unavailable');
  });
  it('does not admit an omitted candidate prerequisite', () => {
    const core = summarizeCoreCollection({
      closed: true,
      entries: [],
      executionFailureIds: [],
    });
    expect(
      candidateAdmission(analysis(), {
        core,
        governance,
        graphTransaction: transaction,
      }).state,
    ).toBe('unavailable');
  });
  it('keeps completed Core immutable when the post-collection transaction fails', () => {
    const caches = createProjectDependencyCaches();
    recordCoreWork(caches, item);
    coreCollectionRun(caches).closed = true;
    const result = analysis();
    finishAnalysisOutcome(result, caches, governance);
    const core = structuredClone(result.outcome!.core);
    retainAnalysisFailure(caches, new Error('output projection failed'));
    finishAnalysisOutcome(result, caches, governance);
    expect(result.outcome!.core).toEqual(core);
    expect(result.outcome!.execution).toBe('completed');
    expect(result.outcome!.graphTransaction.state).toBe('failed');
    expect(result.outcome!.buildAdmission.state).toBe('unavailable');
  });
  it('reports an actual Core failure independently of a drained worklist', () => {
    const caches = createProjectDependencyCaches();
    recordCoreWork(caches, { ...item, execution: 'failed' });
    retainAnalysisFailure(caches, new Error('compiler failed'), 'A');
    coreCollectionRun(caches).closed = true;
    const result = analysis();
    finishAnalysisOutcome(result, caches, governance);
    expect(result.outcome!.core.dispatch).toBe('completed');
    expect(result.outcome!.execution).toBe('failed');
    expect(result.outcome!.buildAdmission.state).toBe('unavailable');
  });
});

it('starts a fresh execution ledger when dependency caches are reused', () => {
  const caches = createProjectDependencyCaches();
  coreCollectionRun(caches).closed = true;
  beginCoreCollection(caches);
  retainAnalysisFailure(caches, new Error('new compiler failure'), 'A');
  expect(coreCollectionRun(caches).failureIds.size).toBe(1);
  expect(coreCollectionRun(caches).transactionFailures).toEqual([]);
});

it('retains a usable candidate outside an actual failure scope', () => {
  const caches = createProjectDependencyCaches();
  recordCoreWork(caches, item);
  recordCoreWork(caches, { ...item, configPath: 'B', execution: 'failed' });
  retainAnalysisFailure(caches, new Error('B compiler failed'), 'B');
  coreCollectionRun(caches).closed = true;
  const result = analysis();
  finishAnalysisOutcome(result, caches, governance);
  expect(result.outcome!.execution).toBe('partial');
  expect(result.outcome!.core.dispatch).toBe('completed');
  expect(result.outcome!.buildAdmission.state).toBe('admitted');
});
