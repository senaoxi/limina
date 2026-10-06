import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import { materializeGeneratedArtifactPlan } from '../core/build-graph/materializer';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import type { MaterializationReceipt } from './types';

export interface MaterializationSlot {
  generation: number;
  inFlight?: Promise<MaterializationReceipt>;
  receipt?: MaterializationReceipt;
}

interface EnsureMaterializationOptions {
  getCurrentSlot: () => MaterializationSlot;
  materialize: () => Promise<MaterializationReceipt>;
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

function commitReceipt(context: MaterializationCommitContext): void {
  if (!isCurrentCommit(context)) {
    return;
  }

  context.slot.receipt = context.receipt;
  context.slot.inFlight = undefined;
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

function createMaterializationPromise(
  options: EnsureMaterializationOptions,
): Promise<MaterializationReceipt> {
  return options.materialize();
}

export function ensureMaterialization(
  options: EnsureMaterializationOptions,
): Promise<MaterializationReceipt> {
  if (options.slot.receipt !== undefined) {
    return Promise.resolve(options.slot.receipt);
  }

  if (options.slot.inFlight !== undefined) {
    return options.slot.inFlight;
  }

  const inFlight = createMaterializationPromise(options);
  options.slot.inFlight = inFlight;

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
      throw error;
    }
    commitReceipt({
      currentSlot: options.getCurrentSlot(),
      inFlight,
      receipt,
      slot: options.slot,
    });
    return receipt;
  })();
}

interface PreflightMaterializationSource {
  artifactNamespace: LiminaArtifactNamespace;
  ensureGeneratedGraph: () => Promise<GeneratedTsconfigGraphResult>;
  run: { metrics: AnalysisMetricsRecorder };
}

export function ensurePreflightGraphMaterialized(options: {
  getCurrentSlot: () => MaterializationSlot;
  refreshProviders: () => void;
  slot: MaterializationSlot;
  source: PreflightMaterializationSource;
}): Promise<MaterializationReceipt> {
  const namespace = options.source.artifactNamespace;
  const metrics = options.source.run.metrics;
  return ensureMaterialization({
    getCurrentSlot: options.getCurrentSlot,
    materialize: () =>
      materializePreflightGraph({
        getGraph: () => options.source.ensureGeneratedGraph(),
        getNamespace: () =>
          options.getCurrentSlot() === options.slot
            ? options.source.artifactNamespace
            : namespace,
        metrics,
        refreshProviders: options.refreshProviders,
        slot: options.slot,
      }),
    slot: options.slot,
  });
}

async function materializePreflightGraph(options: {
  getGraph: () => Promise<GeneratedTsconfigGraphResult>;
  getNamespace: () => LiminaArtifactNamespace;
  metrics: AnalysisMetricsRecorder;
  refreshProviders: () => void;
  slot: MaterializationSlot;
}): Promise<MaterializationReceipt> {
  let graph = await options.getGraph();
  const materialized = await materializeGeneratedArtifactPlan(
    options.getNamespace(),
    graph.artifactPlan,
    {
      metrics: options.metrics,
      replan: async () => {
        options.refreshProviders();
        graph = await options.getGraph();
        return { namespace: options.getNamespace(), plan: graph.artifactPlan };
      },
    },
  );
  if (materialized.plan !== graph.artifactPlan) {
    throw new Error(
      'Materialization selected a plan outside the preflight graph generation.',
    );
  }
  return { changed: graph.changed, generation: options.slot.generation, graph };
}
