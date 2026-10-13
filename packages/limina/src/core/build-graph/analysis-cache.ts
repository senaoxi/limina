import type { ResolvedLiminaInputs } from '#config/runner';
import { invocationDataVersion } from '../../config/invocation-data';
import { assertArtifactPathLexicallyContained } from '../../domain/artifacts/namespace';
import { createRevisionedArtifactPlan } from '../../domain/artifacts/plan';
import { decodeData } from '../analysis-cache/data-codec';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { ValidatedWorkspaceContext } from '../workspace/validated-context';
import {
  type CachedGraphData,
  parseCachedGraph,
  type StoredGraphData,
} from './analysis-cache-schema';
import { restoreGraphContexts, storeGraphContexts } from './analysis-cache-vue';
import { removeStaleGeneratedFiles } from './artifact-ledger';
import { writeGeneratedContent } from './artifact-writer';
import { readMaterializationStateSnapshot } from './materialization-state';
import type {
  DependencyAnalysisResult,
  GeneratedGraphWriteContext,
  GeneratedTsconfigGraphResult,
  PrepareGeneratedTsconfigGraphOptions,
} from './types';
import { getBuildGraphWorkspace } from './workspace-input';

const key = 'generated-graph-v1';

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
function decodeGraph(data: unknown): StoredGraphData | undefined {
  try {
    return parseCachedGraph(decodeData(data));
  } catch {
    return undefined;
  }
}
interface GraphRestoreInput {
  cache: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  workspace: ValidatedWorkspaceContext;
  generation?: number;
}
async function readGraph(
  options: GraphRestoreInput,
): Promise<CachedGraphData | undefined> {
  const version = versions(options.config, options.workspace);
  if (version === undefined) {
    options.cache.fallback(graphFallbackReason(options.config));
    return undefined;
  }
  return readVersionedGraph(options, version);
}
async function readVersionedGraph(
  options: GraphRestoreInput,
  version: { workspaceVersion: string },
): Promise<CachedGraphData | undefined> {
  const record = await options.cache.restoreGraphRecord(
    key,
    version.workspaceVersion,
  );
  if (record === undefined) return undefined;
  const data = decodeBoundGraph(options, record);
  if (data === undefined) {
    delete options.cache.graphs[key];
    options.cache.fallback('graph-dto-invalid');
    return undefined;
  }
  options.cache.increment('graphHits');
  return data;
}
function decodeBoundGraph(
  options: GraphRestoreInput,
  record: NonNullable<
    Awaited<ReturnType<NativeAnalysisCache['restoreGraphRecord']>>
  >,
): CachedGraphData | undefined {
  const stored = decodeGraph(record.data);
  return stored === undefined
    ? undefined
    : restoreGraphContexts({
        cache: options.cache,
        data: stored,
        contextIds: record.vueContextIds,
        generation: options.generation ?? 0,
      });
}
export async function restoreGeneratedGraph(
  options: GraphRestoreInput & {
    preparation: PrepareGeneratedTsconfigGraphOptions;
  },
): Promise<GeneratedTsconfigGraphResult | undefined> {
  const data = await readGraph({
    ...options,
    generation: options.preparation.projectConfigCache?.generation,
  });
  return data === undefined ? undefined : rebindArtifacts(data, options);
}
export async function restoreCachedDependencyAnalysis(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<DependencyAnalysisResult | undefined> {
  const cache = options.projectDependencyCaches?.analysisCache;
  return cache === undefined
    ? undefined
    : restoredAnalysis(cache, config, options);
}
async function restoredAnalysis(
  cache: NativeAnalysisCache,
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<DependencyAnalysisResult | undefined> {
  return (
    await readGraph({
      cache,
      config,
      generation: options.projectConfigCache?.generation,
      workspace: await getBuildGraphWorkspace({
        config,
        workspaceContext: options.workspaceContext,
      }),
    })
  )?.dependencyAnalysis;
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
  return { ...data, changed: context.changed, artifactPlan };
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
    options.result.checkers.some(
      (checker) => !['tsc', 'tsgo', 'vue-tsc'].includes(checker.name),
    )
  ) {
    options.cache.fallback('graph-framework');
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
  // Runtime authority never crosses the persistence boundary.
  options.cache.captureGraphRecord(key, {
    ...version,
    value: storeGraphContexts(value as CachedGraphData),
  });
}
