import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import { captureBoundedContext } from '../analysis-cache/bounded-context-capture';
import type { BoundedObservationPlan } from '../analysis-cache/bounded-observation-plan';
import { EpochInputs } from '../analysis-cache/epoch-inputs';
import { retainContextExecutionInputs } from '../analysis-cache/execution-inputs';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { recordCacheHit } from '../analysis-cache/profile-decisions';
import {
  retainQualifiedNativeContext,
  storedContextFacts,
} from '../analysis-cache/restored-context';
import { restoreBoundedObservationQueries } from '../analysis-cache/retained-bounded-queries';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from './contracts';
import { composeNativeContext } from './native-context-composition';
import { failedNativeDependencyContext } from './native-context-failure';
import { nativeContextInputs } from './native-context-inputs';
import { NativeDependencyContext } from './native-dependency-context';
import {
  NativeObservationAdapter,
  type NativeProgramObservationOptions,
} from './native-observation-adapter';
import { nativeObservationFailureKind } from './native-observation-failure';

type CollectedContext = TypeScriptSemanticDependencyContext & {
  dispose(): void;
};

/**
The publication scope receives only the reads of an accepted collection.
*/
export function createNativeDependencyContext(
  project: TypeScriptSemanticProject,
  cache?: NativeAnalysisCache,
  metrics?: AnalysisMetricsRecorder,
): CollectedContext {
  const reads = new EpochInputs(cache?.inputs);
  const input = reads.collect(() => ({
    ...nativeContextInputs(
      { ...project, admissionMode: 'coverage-bounded' },
      cache,
    ),
    metrics,
  }));
  if (cache && input.queries) {
    const plan = cache.observationPlan(input.project);
    if (plan !== undefined) {
      const partial = observeChangedImporters(input, cache, reads, plan);
      if (partial !== undefined) return partial;
      cache.fallback('partial-inventory-unqualified');
      input.queries.ids.clear();
    }
  }
  const context = reads.collect(() => {
    try {
      return observeProgram(input, cache).context;
    } catch (error) {
      if (nativeObservationFailureKind(error) === 'input-drift') throw error;
      return failedNativeDependencyContext(input, error);
    }
  });
  const ids = input.queries?.ids;
  const record =
    ids &&
    cache &&
    captureBoundedContext({
      project: input.project,
      context,
      cache,
      queryIds: ids,
      discovery: reads.snapshot(),
    });
  retainContextExecutionInputs(
    context.nativeEvidence,
    input.project.configPath,
    reads,
    ids &&
      cache && { cache, ids, environment: record?.environment.dependencies },
  );
  return context;
}

function observeProgram(
  input: NativeProgramObservationOptions,
  cache?: NativeAnalysisCache,
) {
  if (cache !== undefined) {
    input.metrics?.record({
      name: 'analysis-cache',
      kind: 'context-rebuilt',
      provider: 'typescript',
      context: input.project.configPath,
      count: 1,
    });
    cache.recordProgram();
  }
  const adapter = new NativeObservationAdapter(input);
  const context = new NativeDependencyContext(
    input,
    adapter,
    cache &&
      ((file, text) =>
        cache.readFileSyntax(file, text, input.queries && input.project)),
  );
  return { adapter, context };
}

function observeChangedImporters(
  input: NativeProgramObservationOptions,
  cache: NativeAnalysisCache,
  baseReads: EpochInputs,
  plan: BoundedObservationPlan,
): NativeDependencyContext | undefined {
  const reads = new EpochInputs(cache.inputs);
  reads.append(baseReads);
  const result = reads.run(() => {
    const { adapter, context } = observeProgram(
      { ...input, observationRootNames: plan.observationRoots },
      cache,
    );
    return composeNativeContext({
      adapter,
      observed: context,
      previous: storedContextFacts(
        input.context.id,
        plan.record,
        cache.previous!.importers,
      ),
      reusableFiles: plan.reusableFiles,
      readPreviousSyntax: (file) =>
        cache.previousFileSyntax(input.project, file),
    });
  });
  if (result === undefined) return undefined;
  reads.append(plan.priorDiscovery);
  const ids = restoreBoundedObservationQueries(
    cache,
    plan,
    input.queries!.ids,
    result.restoredFiles,
    result.restoredLibraryNames,
  );
  const { context } = result;
  const record = captureBoundedContext({
    project: input.project,
    context,
    cache,
    queryIds: ids,
    discovery: reads.snapshot(),
    requireComplete: true,
  });
  if (record === undefined) return undefined;
  retainContextExecutionInputs(
    context.nativeEvidence,
    input.project.configPath,
    reads,
    { cache, ids, environment: record.environment.dependencies },
  );
  retainQualifiedNativeContext(context);
  reads.publish();
  cache.increment('partialContexts');
  for (const file of result.restoredFiles) {
    cache.increment('restoredImporters');
    recordCacheHit('importer-facts', cache.previousOrigin, file);
  }
  return context;
}
