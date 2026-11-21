import {
  type AnalysisObserver,
  currentProfile,
} from '../../application/analysis/observability';
import type { PreparedTsconfigGraph } from './types';

type GraphPurpose = 'complete' | 'producer-build' | 'dependency-analysis';
type GraphSource = 'computed' | 'restored';

interface SharedGraphWork {
  readonly work: string;
  state: 'pending' | 'succeeded' | 'failed';
}

interface GraphObservation {
  requests: WeakMap<Promise<object>, SharedGraphWork>;
  preparations: WeakMap<object, string>;
}

const observations = new WeakMap<AnalysisObserver, GraphObservation>();

function observation(profile: AnalysisObserver): GraphObservation {
  let state = observations.get(profile);
  if (state === undefined) {
    state = { requests: new WeakMap(), preparations: new WeakMap() };
    observations.set(profile, state);
  }
  return state;
}

export function graphPreparationWork(
  profile: AnalysisObserver,
  graph: object,
): string | undefined {
  return observations.get(profile)?.preparations.get(graph);
}

export function beginObservedGraphWait(
  profile: AnalysisObserver,
  producer: string,
  operation: 'graph.wait.preparation' | 'graph.wait.materialization',
): (result: 'shared' | 'failed') => void {
  const work = profile.start(operation);
  return (result) => profile.finishSharedWait(work, producer, result);
}

export function capturePendingGraphWait(
  profile: AnalysisObserver,
  pending: Promise<object>,
): ReturnType<typeof beginObservedGraphWait> | undefined {
  const producer = observations.get(profile)?.requests.get(pending);
  return producer?.state === 'pending'
    ? beginObservedGraphWait(profile, producer.work, 'graph.wait.preparation')
    : undefined;
}

export function recordGraphPreparation(
  profile: AnalysisObserver,
  graph: PreparedTsconfigGraph,
  gate: 'core' | 'preflight',
  work: string,
  source?: GraphSource,
): void {
  const result = profile.identity(graph, 'graph');
  const providerRun = profile.currentProviderRun();
  const projects =
    source === 'restored'
      ? [
          ...new Set(
            graph.governedSources
              .values()
              .flatMap((units) =>
                units.keys().map((config) => profile.project(config)),
              ),
          ),
        ]
      : undefined;
  profile.graph(result, {
    purpose: graph.purpose,
    ...(providerRun !== undefined && { providerRun }),
    ...(gate === 'core' && { producer: work }),
    ...(source !== undefined && { source }),
    ...(projects !== undefined && { projects }),
    result,
    plan: profile.identity(graph.artifactPlan, 'plan'),
    prepared: [{ gate, atUs: profile.now() }],
  });
  observation(profile).preparations.set(graph, work);
}

export function observeGraphRequest<T extends object>(
  purpose: GraphPurpose,
  pending: Promise<T> | undefined,
  load: () => Promise<T>,
  requestGate: 'preflight' | 'core' = 'preflight',
  willObserveJoin?: true,
): Promise<T> {
  const profile = currentProfile();
  if (profile === undefined) return pending ?? load();

  const id = profile.id('graph-request');
  const requestAtUs = profile.now();
  const request = profile.start('graph.request', ['graph', id]);
  const { requests } = observation(profile);
  const producer = pending === undefined ? undefined : requests.get(pending);
  if (producer !== undefined) {
    if (producer.state !== 'pending')
      profile.link('uses-result', request, producer.work);
    else if (!willObserveJoin)
      profile.link('waits-for', request, producer.work);
    if (producer.state === 'succeeded')
      profile.share('graph.request.reuse', ['graph', id], producer.work);
  }
  profile.graph(id, {
    request,
    requestAtUs,
    requestGate,
    purpose,
    ...(producer !== undefined && { producer: producer.work }),
  });

  const promise = pending ?? profile.inWork(request, load);
  const actual: SharedGraphWork = { work: request, state: 'pending' };
  if (pending === undefined) requests.set(promise, actual);
  else if (producer?.state === 'failed')
    profile.finish(request, 'failed', 'cached-graph-preparation-failed');
  else profile.finish(request);
  (async () => {
    try {
      const graph = await promise;
      actual.state = 'succeeded';
      const preparation = graphPreparationWork(profile, graph);
      if (preparation !== undefined && producer === undefined)
        profile.link('uses-result', request, preparation);
      profile.graph(id, {
        result: profile.identity(graph, 'graph'),
        ...(producer !== undefined && { source: 'shared' }),
        ...(preparation !== undefined &&
          producer === undefined && { producer: preparation }),
      });
      if (pending === undefined) profile.finish(request);
    } catch {
      actual.state = 'failed';
      if (pending === undefined) profile.finish(request, 'failed');
    }
  })();
  return promise;
}
