import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import { currentProfile } from '../../application/analysis/observability';
import { invocationDataVersion } from '../../config/invocation-data';
import { assertArtifactPathLexicallyContained } from '../../domain/artifacts/namespace';
import { createRevisionedArtifactPlan } from '../../domain/artifacts/plan';
import { decodeData } from '../analysis-cache/data-codec';
import { hasBoundRestoredGraphExecutionInputs } from '../analysis-cache/execution-inputs';
import { completeFrameworkExecutionInputs } from '../analysis-cache/framework-execution-inputs';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import {
  type CacheOrigin,
  recordCacheMiss,
} from '../analysis-cache/profile-decisions';
import type { ValidatedWorkspaceContext } from '../workspace/validated-context';
import {
  type CachedGraphData,
  parseCachedGraph,
  type StoredGraphData,
} from './analysis-cache-schema';
import { storeGraphContexts } from './analysis-cache-vue';
import { removeStaleGeneratedFiles } from './artifact-ledger';
import { writeGeneratedContent } from './artifact-writer';
import { bindCachedGraph, type BoundCachedGraph } from './cached-graph-binding';
import { restoreOwnershipInputs } from './cached-ownership-replay';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import { recordFrameworkInferenceAmbiguities } from './core-collection-run';
import { hasValidRestoredDeclarationContexts } from './declaration-context-candidate';
import { hasBoundGeneratedReferences } from './generated-reference-binding';
import { hasValidLibraryProjections } from './library-projection';
import { readMaterializationStateSnapshot } from './materialization-state';
import { hasBoundNativeGraph } from './native-cache-binding';
import {
  restoreNativeGraphViews,
  storeNativeGraphViews,
} from './native-graph-views';
import { isValidOutputProjection } from './output-projection';
import { planScopedCheckArtifacts } from './scoped-check-artifacts';
import { isValidTypeInputProjection } from './type-input-projection';
import type {
  DependencyAnalysisResult,
  GeneratedGraphWriteContext,
  GeneratedTsconfigGraphResult,
  PrepareGeneratedTsconfigGraphOptions,
} from './types';
import { getBuildGraphWorkspace } from './workspace-input';
const key = 'generated-graph-config-ownership-v27';
function hasVirtualInputs(config: ResolvedLiminaInputs): boolean {
  return (config.virtualFiles?.size ?? 0) > 0;
}
function graphFallbackReason(config: ResolvedLiminaInputs): string {
  return hasVirtualInputs(config)
    ? 'graph-virtual-inputs'
    : 'graph-workspace-executable';
}
function versions(
  config: ResolvedLiminaInputs,
  workspace: ValidatedWorkspaceContext,
) {
  const workspaceVersion = invocationDataVersion({
    packages: workspace.packages,
    boundaries: workspace.boundaries,
    packageIdentities: workspace.packageIdentities,
    descriptors: workspace.descriptorCandidates,
    sources: workspace.sourceConfigPaths,
    outputs: workspace.outputRoots,
  });
  return [hasVirtualInputs(config), workspaceVersion === undefined].some(
    Boolean,
  )
    ? undefined
    : { workspaceVersion: workspaceVersion! };
}
function decodeGraph(
  data: unknown,
  cache: NativeAnalysisCache,
): StoredGraphData | undefined {
  try {
    return parseCachedGraph(
      restoreNativeGraphViews(decodeData(data, true), cache),
    );
  } catch {
    return undefined;
  }
}
interface GraphRestoreInput {
  cache: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  workspace: ValidatedWorkspaceContext;
  generation?: number;
  projectConfigCache?: CheckerProjectConfigCache;
  metrics?: AnalysisMetricsRecorder;
  importAnalysisContext?: PrepareGeneratedTsconfigGraphOptions['importAnalysisContext'];
}
interface RestoredGraphProjection {
  readonly data: BoundCachedGraph;
  readonly origin: CacheOrigin;
  readonly snapshotDecision?: string;
}

function recordGraphAdoption(
  graph: object,
  { origin, snapshotDecision }: RestoredGraphProjection,
): void {
  const profile = currentProfile();
  if (profile === undefined) return;
  const subject = profile.identity(graph, 'graph');
  const lookup = profile.decision(
    'analysis-graph',
    {
      stage: 'lookup',
      outcome: 'found',
      basis: snapshotDecision === undefined ? undefined : [snapshotDecision],
    },
    subject,
  );
  const admission = profile.decision(
    'analysis-graph',
    {
      stage: 'admission',
      outcome: 'admitted',
      basis: [lookup],
    },
    subject,
  );
  profile.decision(
    'analysis-graph',
    {
      stage: 'adoption',
      outcome: 'adopted',
      origin,
      basis: [admission],
    },
    subject,
  );
}

async function readGraph(
  options: GraphRestoreInput,
): Promise<RestoredGraphProjection | undefined> {
  const version = versions(options.config, options.workspace);
  if (version === undefined) {
    options.cache.fallback(graphFallbackReason(options.config));
    recordCacheMiss('analysis-graph', graphFallbackReason(options.config), {
      bypassed: true,
      basis: options.cache.snapshotDecision,
    });
    return undefined;
  }
  return readVersionedGraph(options, version);
}
async function readVersionedGraph(
  options: GraphRestoreInput,
  version: { workspaceVersion: string },
): Promise<RestoredGraphProjection | undefined> {
  const candidate = options.cache.graphCandidate(key, version.workspaceVersion);
  if (candidate === undefined) return undefined;
  const origin =
    options.cache.graphs[key] === candidate
      ? 'invocation-memory'
      : options.cache.previousOrigin;
  const ownershipInputs = await restoreOwnershipInputs(
    options.config,
    options.workspace,
    options.cache,
    options.projectConfigCache,
  );
  if (ownershipInputs === undefined) {
    recordCacheMiss('analysis-graph', 'ownership-inputs-replay-rejected', {
      basis: options.cache.snapshotDecision,
    });
    return undefined;
  }
  const record = await options.cache.restoreGraphRecord(
    key,
    candidate,
    restoredGeneration(options),
  );
  if (record === undefined) return undefined;
  const data = decodeBoundGraph({ ...options, ownershipInputs }, record);
  if (data === undefined) {
    delete options.cache.graphs[key];
    options.cache.fallback('graph-dto-invalid');
    recordCacheMiss('analysis-graph', 'graph-dto-or-binding-invalid', {
      basis: options.cache.snapshotDecision,
    });
    return undefined;
  }
  return { data, origin, snapshotDecision: options.cache.snapshotDecision };
}
function decodeBoundGraph(
  options: GraphRestoreInput & { ownershipInputs: CheckerOwnershipDiscovery },
  record: NonNullable<
    Awaited<ReturnType<NativeAnalysisCache['restoreGraphRecord']>>
  >,
): BoundCachedGraph | undefined {
  const stored = decodeGraph(record.data, options.cache);
  return isRestorableGraph(stored, options)
    ? bindAndRestoreGraph(options, { stored, record })
    : undefined;
}
function isRestorableGraph(
  stored: StoredGraphData | undefined,
  options: GraphRestoreInput,
): stored is StoredGraphData {
  return (
    stored !== undefined &&
    [
      hasBoundGeneratedReferences(stored, options.config),
      isValidBoundGraph(stored, options.cache),
    ].every(Boolean)
  );
}
function bindAndRestoreGraph(
  options: GraphRestoreInput & { ownershipInputs: CheckerOwnershipDiscovery },
  input: {
    stored: StoredGraphData;
    record: NonNullable<
      Awaited<ReturnType<NativeAnalysisCache['restoreGraphRecord']>>
    >;
  },
): BoundCachedGraph | undefined {
  const { stored, record } = input;
  return bindCachedGraph({
    ...options,
    stored,
    contextIds: record.vueContextIds,
    generation: restoredGeneration(options),
  });
}
function isValidBoundGraph(
  stored: StoredGraphData,
  cache: NativeAnalysisCache,
): boolean {
  return (
    hasBoundNativeGraph(stored, cache.contexts, cache.importers) &&
    hasValidProjections(stored, cache)
  );
}
export async function restoreGeneratedGraph(
  options: GraphRestoreInput & {
    preparation: PrepareGeneratedTsconfigGraphOptions;
  },
): Promise<GeneratedTsconfigGraphResult | undefined> {
  const restored = await readGraph({
    ...options,
    generation: options.preparation.projectConfigCache?.generation,
    projectConfigCache: options.preparation.projectConfigCache,
    importAnalysisContext: options.preparation.importAnalysisContext,
    metrics: options.preparation.projectDependencyCaches?.metrics,
  });
  if (restored === undefined) return undefined;
  const { data } = restored;
  if (
    !hasValidRestoredDeclarationContexts(
      data.graph,
      options.preparation.projectDependencyCaches?.metrics,
      options.config.rootDir,
    )
  ) {
    recordCacheMiss('analysis-graph', 'declaration-candidate-rejected', {
      basis: options.cache.snapshotDecision,
    });
    return undefined;
  }
  const graph = await rebindArtifacts(data.graph, options);
  if (!hasBoundRestoredGraphExecutionInputs(graph, options.cache)) {
    delete options.cache.graphs[key];
    options.cache.fallback('graph-execution-inputs-incomplete');
    recordCacheMiss('analysis-graph', 'execution-inputs-incomplete', {
      basis: options.cache.snapshotDecision,
    });
    return undefined;
  }
  options.cache.increment('graphHits');
  recordGraphAdoption(graph, restored);
  if (options.preparation.projectDependencyCaches !== undefined)
    recordFrameworkInferenceAmbiguities(
      options.preparation.projectDependencyCaches,
      data.ambiguities,
    );
  return graph;
}
export async function restoreCachedDependencyAnalysis(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<DependencyAnalysisResult | undefined> {
  const cache = options.projectDependencyCaches?.analysisCache;
  if (cache === undefined || options.producerBuildReceipt !== undefined) {
    recordCacheMiss(
      'analysis-graph',
      cache === undefined
        ? 'cache-controller-unavailable'
        : 'managed-execution-view',
      { bypassed: true, basis: cache?.snapshotDecision },
    );
    return undefined;
  }
  return restoredAnalysis(cache, config, options);
}
async function restoredAnalysis(
  cache: NativeAnalysisCache,
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<DependencyAnalysisResult | undefined> {
  const restored = await readGraph({
    cache,
    config,
    generation: options.projectConfigCache?.generation,
    projectConfigCache: options.projectConfigCache,
    importAnalysisContext: options.importAnalysisContext,
    metrics: options.projectDependencyCaches?.metrics,
    workspace: await getBuildGraphWorkspace({
      config,
      workspaceContext: options.workspaceContext,
    }),
  });
  if (restored === undefined) return undefined;
  cache.increment('graphHits');
  const { data } = restored;
  recordGraphAdoption(data.graph.dependencyAnalysis, restored);
  if (options.projectDependencyCaches !== undefined)
    recordFrameworkInferenceAmbiguities(
      options.projectDependencyCaches,
      data.ambiguities,
    );
  return data.graph.dependencyAnalysis;
}
async function rebindArtifacts(
  data: CachedGraphData,
  options: Parameters<typeof restoreGeneratedGraph>[0],
): Promise<GeneratedTsconfigGraphResult> {
  const namespace = options.preparation.artifactNamespace;
  for (const file of data.generatedFiles.keys())
    assertArtifactPathLexicallyContained(namespace, file);
  assertArtifactPathLexicallyContained(namespace, data.manifestPath);
  const context: GeneratedGraphWriteContext = {
    changes: [],
    changed: false,
    expectedFiles: new Set(),
    files: new Map(),
    rootDir: options.config.rootDir,
  };
  const base = await readMaterializationStateSnapshot(namespace);
  const previousOwnedPaths = base.ownedPaths.map(
    (file) => `${namespace.rootDir}/${file}`,
  );
  for (const [filePath, content] of data.generatedFiles)
    await writeGeneratedContent({ context, filePath, content });
  const auxiliaryArtifacts = await planScopedCheckArtifacts(
    { purpose: data.purpose, writeContext: context },
    namespace,
  );
  await removeStaleGeneratedFiles({ context, previousOwnedPaths });
  const artifactPlan = createRevisionedArtifactPlan(
    namespace,
    context.changes,
    {
      baseOwnedPaths: previousOwnedPaths,
      baseRevision: base.revision,
      ownedPaths: [...context.expectedFiles],
    },
  );
  const graph = {
    ...data,
    changed: context.changed,
    artifactPlan,
    auxiliaryArtifacts,
  };
  await completeFrameworkExecutionInputs(graph, options.config);
  return graph;
}
export function captureGeneratedGraph(options: {
  cache: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  workspace: ValidatedWorkspaceContext;
  result: GeneratedTsconfigGraphResult;
  analysis: DependencyAnalysisResult;
}): void {
  const version = versions(options.config, options.workspace);
  if (version === undefined) {
    options.cache.fallback(graphFallbackReason(options.config));
    return;
  }
  captureSupportedGraph(options, version);
}
function captureSupportedGraph(
  options: Parameters<typeof captureGeneratedGraph>[0],
  version: { workspaceVersion: string },
): void {
  if (
    options.result.purpose !== 'complete' ||
    options.result.producerBuildReceipt !== undefined ||
    (options.result.auxiliaryArtifacts?.length ?? 0) > 0
  ) {
    options.cache.fallback('graph-managed-execution-view');
    return;
  }
  options.cache.captureLiveContexts();
  if (!options.cache.vue.complete()) {
    options.cache.fallback('graph-proof-unknown');
    return;
  }
  captureGraphData(options, version);
}
function captureGraphData(
  options: Parameters<typeof captureGeneratedGraph>[0],
  version: { workspaceVersion: string },
): void {
  const value: Partial<GeneratedTsconfigGraphResult> & {
    dependencyAnalysis: DependencyAnalysisResult;
  } = { ...options.result, dependencyAnalysis: options.analysis };
  delete value.artifactPlan;
  delete value.changed;
  delete value.producerBuildReceipt;
  delete value.auxiliaryArtifacts;
  // Runtime authority never crosses the persistence boundary.
  const stored = storeGraphContexts(value as CachedGraphData);
  if (stored === undefined) {
    options.cache.fallback('graph-framework-inputs-incomplete');
    return;
  }
  if (
    !hasBoundNativeGraph(
      stored,
      options.cache.contexts,
      options.cache.importers,
    )
  ) {
    options.cache.fallback('graph-native-context-unbound');
    return;
  }
  options.cache.captureGraphRecord(key, {
    ...version,
    value: storeNativeGraphViews(stored, options.cache),
  });
}
function hasValidProjections(
  stored: NonNullable<ReturnType<typeof decodeGraph>>,
  cache: NativeAnalysisCache,
): boolean {
  return (
    stored.typeInputProjections!.every((receipt) =>
      isValidTypeInputProjection(receipt, cache, stored.generatedFiles),
    ) &&
    hasValidLibraryProjections(stored, cache) &&
    stored.outputProjections!.every((receipt) =>
      isValidOutputProjection(receipt, cache, stored.generatedFiles),
    )
  );
}
function restoredGeneration(options: GraphRestoreInput): number {
  return options.generation ?? 0;
}
