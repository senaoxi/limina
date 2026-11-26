import type { PreparedTsconfigGraph } from '#core/build-graph/runner';
import type {
  AnalysisMetricsRecorder,
  AnalysisRun,
} from '../application/analysis/analysis-run';
import {
  type AnalysisObserver,
  currentProfile,
} from '../application/analysis/observability';
import {
  beginObservedGraphWait,
  capturePendingGraphWait,
  graphPreparationWork,
} from '../core/build-graph/graph-profile';
import { materializeGeneratedArtifactPlan } from '../core/build-graph/materializer';
import { prepareProducerDeclarationMirrors } from '../core/build-graph/producer-declaration-mirrors';
import {
  assertProducerBuildReceipt,
  type ProducerBuildReceipt,
} from '../core/build-graph/producer-receipt';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import type { MaterializationReceipt } from './types';

export interface MaterializationSlot {
  generation: number;
  inFlight?: Promise<MaterializationReceipt>;
  receipt?: MaterializationReceipt;
}

export type MaterializationAccess = 'start' | 'join' | 'reuse';

export type MaterializationAccessObserver = (
  access: MaterializationAccess,
  startedAt: number,
) => void;

interface EnsureMaterializationOptions {
  getCurrentSlot: () => MaterializationSlot;
  materialize: () => Promise<MaterializationReceipt>;
  onAccess?: MaterializationAccessObserver;
  onCommit?: (receipt: MaterializationReceipt) => void;
  slot: MaterializationSlot;
}

interface MaterializationCommitContext {
  currentSlot: MaterializationSlot;
  inFlight: Promise<MaterializationReceipt>;
  receipt: MaterializationReceipt;
  slot: MaterializationSlot;
}

function isCurrentCommit(context: MaterializationCommitContext): boolean {
  const checks = [
    context.currentSlot === context.slot,
    context.slot.inFlight === context.inFlight,
    context.slot.generation === context.receipt.generation,
  ];

  return checks.every(Boolean);
}

function clearFailedInFlight(options: {
  currentSlot: MaterializationSlot;
  inFlight: Promise<MaterializationReceipt>;
  slot: MaterializationSlot;
}): void {
  const isCurrent =
    options.currentSlot === options.slot &&
    options.slot.inFlight === options.inFlight;

  if (isCurrent) {
    options.slot.inFlight = undefined;
  }
}

const materializations = new WeakMap<
  AnalysisObserver,
  WeakMap<MaterializationSlot, string>
>();

function recordedMaterializations(profile: AnalysisObserver) {
  let recorded = materializations.get(profile);
  if (recorded === undefined) {
    recorded = new WeakMap();
    materializations.set(profile, recorded);
  }
  return recorded;
}

export function recordActiveMaterializationReceipt(
  receipt: MaterializationReceipt,
  slot: MaterializationSlot,
  view: AnalysisRun,
): void {
  const profile = currentProfile();
  if (
    profile === undefined ||
    receipt.graph.purpose !== 'complete' ||
    slot.receipt !== receipt
  )
    return;
  profile.graph(profile.identity(receipt.graph, 'graph'), {
    receipt: {
      id: profile.identity(receipt, 'receipt'),
      slot: profile.identity(slot, 'slot'),
      view: profile.identity(view, 'view'),
      atUs: profile.now(),
    },
  });
}

export function capturePendingMaterializationWait(
  slot: MaterializationSlot,
  pending: Promise<MaterializationReceipt>,
): ReturnType<typeof beginObservedGraphWait> | undefined {
  const profile = currentProfile();
  if (profile === undefined || pending !== slot.inFlight) return undefined;
  const producer = materializations.get(profile)?.get(slot);
  return producer === undefined
    ? undefined
    : beginObservedGraphWait(profile, producer, 'graph.wait.materialization');
}

export function ensureMaterialization(
  options: EnsureMaterializationOptions,
): Promise<MaterializationReceipt> {
  const { receipt: ready, inFlight: pending } = options.slot;
  if (ready !== undefined) {
    options.onAccess?.('reuse', performance.now());
    return Promise.resolve(ready);
  }

  if (pending !== undefined) {
    options.onAccess?.('join', performance.now());
    return pending;
  }

  const startedAt = performance.now();
  const profile = currentProfile();
  const work = profile?.start('graph.materialize');
  const inFlight =
    profile !== undefined && work !== undefined
      ? profile.inWork(work, options.materialize)
      : options.materialize();
  if (profile !== undefined && work !== undefined)
    recordedMaterializations(profile).set(options.slot, work);
  options.slot.inFlight = inFlight;
  options.onAccess?.('start', startedAt);

  return (async () => {
    let receipt: MaterializationReceipt;
    try {
      receipt = await inFlight;
    } catch (error) {
      clearFailedInFlight({
        currentSlot: options.getCurrentSlot(),
        inFlight,
        slot: options.slot,
      });
      if (work !== undefined)
        profile?.fail(work, error, 'materialization-failed');
      throw error;
    }
    const isCurrent = isCurrentCommit({
      currentSlot: options.getCurrentSlot(),
      inFlight,
      receipt,
      slot: options.slot,
    });
    if (isCurrent) {
      options.slot.receipt = receipt;
      options.slot.inFlight = undefined;
      options.onCommit?.(receipt);
    }
    if (work !== undefined) {
      if (isCurrent) profile?.finish(work);
      else profile?.finish(work, 'superseded', 'materialization-slot-replaced');
    }
    return receipt;
  })();
}

interface PreflightMaterializationSource {
  artifactNamespace: LiminaArtifactNamespace;
  ensureGeneratedGraph: (
    willObserveJoin?: true,
  ) => Promise<PreparedTsconfigGraph>;
  run: { metrics: AnalysisMetricsRecorder };
}

export function ensurePreflightGraphMaterialized(options: {
  getCurrentSlot: () => MaterializationSlot;
  getActiveView?: () => AnalysisRun | undefined;
  getPendingGraph: () => Promise<PreparedTsconfigGraph> | undefined;
  onAccess?: MaterializationAccessObserver;
  willObserveJoin?: true;
  purpose: PreparedTsconfigGraph['purpose'];
  refreshProviders: () => void;
  slot: MaterializationSlot;
  source: PreflightMaterializationSource;
}): Promise<MaterializationReceipt> {
  const namespace = options.source.artifactNamespace;
  const metrics = options.source.run.metrics;
  const materialize = () =>
    ensureMaterialization({
      getCurrentSlot: options.getCurrentSlot,
      onAccess: options.onAccess,
      materialize: () =>
        materializePreflightGraph({
          getGraph: (willObserveJoin) =>
            options.source.ensureGeneratedGraph(willObserveJoin),
          getPendingGraph: options.getPendingGraph,
          getNamespace: () =>
            options.getCurrentSlot() === options.slot
              ? options.source.artifactNamespace
              : namespace,
          metrics,
          refreshProviders: options.refreshProviders,
          slot: options.slot,
        }),
      slot: options.slot,
      onCommit: (receipt) => {
        const view = options.getActiveView?.();
        if (view !== undefined)
          recordActiveMaterializationReceipt(receipt, options.slot, view);
      },
    });
  const profile = currentProfile();
  if (profile === undefined) return materialize();
  const isReady = options.slot.receipt !== undefined;
  const isJoined = options.slot.inFlight !== undefined;
  const sharedProducer =
    isReady || isJoined
      ? materializations.get(profile)?.get(options.slot)
      : undefined;
  const request = observeMaterializationRequest(
    options.purpose,
    options.getActiveView?.() === undefined ? 'applied' : 'receipt',
    materialize,
    isReady || isJoined,
    sharedProducer,
  );
  const actual = recordedMaterializations(profile).get(options.slot);
  if (request !== undefined && actual !== undefined) {
    if (!isJoined) profile.link('uses-result', request.work, actual);
    else if (!options.willObserveJoin)
      profile.link('waits-for', request.work, actual);
  }
  return request?.promise ?? materialize();
}

export function observeMaterializationRequest(
  purpose: PreparedTsconfigGraph['purpose'],
  requestGate: 'applied' | 'receipt',
  load: () => Promise<MaterializationReceipt>,
  isShared = false,
  sharedProducer?: string,
): { promise: Promise<MaterializationReceipt>; work: string } | undefined {
  const profile = currentProfile();
  if (profile === undefined) return undefined;
  const id = profile.id('graph-request');
  const requestAtUs = profile.now();
  const work = profile.start('graph.materialize.request', ['graph', id]);
  profile.graph(id, {
    purpose,
    request: work,
    requestAtUs,
    requestGate,
    ...(sharedProducer !== undefined && { producer: sharedProducer }),
  });
  const promise = profile.inWork(work, load);
  if (isShared) profile.finish(work);
  (async () => {
    try {
      const { graph } = await promise;
      const deliveredAtUs = profile.now();
      profile.graph(id, {
        result: profile.identity(graph, 'graph'),
        deliveredAtUs,
        ...(sharedProducer !== undefined && { source: 'shared' }),
      });
      if (!isShared) profile.finish(work);
    } catch {
      if (!isShared)
        profile.finish(work, 'failed', 'materialization-request-failed');
    }
  })();
  return { promise, work };
}

async function materializePreflightGraph(options: {
  getGraph: (willObserveJoin?: true) => Promise<PreparedTsconfigGraph>;
  getPendingGraph: () => Promise<PreparedTsconfigGraph> | undefined;
  getNamespace: () => LiminaArtifactNamespace;
  metrics: AnalysisMetricsRecorder;
  refreshProviders: () => void;
  slot: MaterializationSlot;
}): Promise<MaterializationReceipt> {
  const profile = currentProfile();
  const previous =
    profile === undefined ? undefined : options.getPendingGraph();
  const pending = options.getGraph(previous && true);
  const finishWait =
    profile !== undefined && previous === pending
      ? capturePendingGraphWait(profile, pending)
      : undefined;
  let graph: PreparedTsconfigGraph;
  try {
    graph = await pending;
    finishWait?.('shared');
  } catch (error) {
    finishWait?.('failed');
    throw error;
  }
  // The prior root manifest is the recovery locator for retiring namespaces.
  // Finish these before replacing it; active namespaces stay discoverable in
  // the new manifest if one of their subsequent transactions is interrupted.
  const retired = new Map<string, string>();
  const initialAuxiliaries = graph.auxiliaryArtifacts ?? [];
  for (const auxiliary of initialAuxiliaries) {
    if (!auxiliary.retiring) continue;
    await materializeGeneratedArtifactPlan(
      auxiliary.namespace,
      auxiliary.plan,
      {
        metrics: options.metrics,
        replan: auxiliary.replan,
      },
    );
    retired.set(
      auxiliary.namespace.canonicalRootDir,
      auxiliary.plan.desiredRevision,
    );
  }
  const materialized = await materializeGeneratedArtifactPlan(
    options.getNamespace(),
    graph.artifactPlan,
    {
      metrics: options.metrics,
      replan: async () => {
        const superseded = graph;
        options.refreshProviders();
        graph = await options.getGraph();
        if (profile !== undefined) {
          const oldWork = graphPreparationWork(profile, superseded);
          const newWork = graphPreparationWork(profile, graph);
          if (
            oldWork !== undefined &&
            newWork !== undefined &&
            newWork !== oldWork
          )
            profile.link('supersedes', newWork, oldWork);
        }
        const nextAuxiliaries = graph.auxiliaryArtifacts ?? [];
        for (const auxiliary of nextAuxiliaries) {
          if (
            auxiliary.retiring &&
            retired.get(auxiliary.namespace.canonicalRootDir) !==
              auxiliary.plan.desiredRevision
          )
            throw new Error(
              'Retiring artifact namespaces changed during root replan. Retry with a fresh graph.',
            );
        }
        return { namespace: options.getNamespace(), plan: graph.artifactPlan };
      },
    },
  );
  if (materialized.plan !== graph.artifactPlan) {
    throw new Error(
      'Materialization selected a plan outside the preflight graph generation.',
    );
  }
  const auxiliaryArtifacts = graph.auxiliaryArtifacts ?? [];
  for (const auxiliary of auxiliaryArtifacts) {
    if (auxiliary.retiring) continue;
    await materializeGeneratedArtifactPlan(
      auxiliary.namespace,
      auxiliary.plan,
      { metrics: options.metrics, replan: auxiliary.replan },
    );
  }
  if (profile !== undefined) {
    const work = profile.currentWork;
    const producer = graphPreparationWork(profile, graph);
    if (producer !== undefined && producer !== work)
      profile.link('uses-result', work, producer);
    profile.graph(profile.identity(graph, 'graph'), {
      purpose: graph.purpose,
      applied: {
        work,
        plan: profile.identity(materialized.plan, 'plan'),
        atUs: profile.now(),
      },
    });
  }
  return { changed: graph.changed, generation: options.slot.generation, graph };
}

export async function materializeProducerDeclarationMirrors(
  receipt: ProducerBuildReceipt,
  namespace: LiminaArtifactNamespace,
  rootDirectory: string,
): Promise<void> {
  const plan = await prepareProducerDeclarationMirrors(
    receipt,
    namespace,
    rootDirectory,
  );
  await materializeGeneratedArtifactPlan(namespace, plan);
  assertProducerBuildReceipt(receipt);
}
