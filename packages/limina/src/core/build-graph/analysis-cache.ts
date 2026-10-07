import type { ResolvedLiminaConfig } from '#config/runner';
import { invocationDataVersion } from '../../config/invocation-data';
import { assertArtifactPathLexicallyContained } from '../../domain/artifacts/namespace';
import { createRevisionedArtifactPlan } from '../../domain/artifacts/plan';
import { decodeData } from '../analysis-cache/data-codec';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { ValidatedWorkspaceContext } from '../workspace/validated-context';
import {
  type CachedGraphData,
  parseCachedGraph,
} from './analysis-cache-schema';
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

function hasVirtualInputs(config: ResolvedLiminaConfig): boolean {
  return (config.virtualFiles?.size ?? 0) > 0;
}
function graphFallbackReason(config: ResolvedLiminaConfig): string {
  return hasVirtualInputs(config)
    ? 'graph-virtual-inputs'
    : 'graph-workspace-executable';
}
function versions(
  config: ResolvedLiminaConfig,
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
function decodeGraph(data: unknown): CachedGraphData | undefined {
  try {
    return parseCachedGraph(decodeData(data));
  } catch {
    return undefined;
  }
}
interface GraphRestoreInput {
  cache: NativeAnalysisCache;
  config: ResolvedLiminaConfig;
  workspace: ValidatedWorkspaceContext;
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
  const data = decodeGraph(record.data);
  if (data === undefined) {
    delete options.cache.graphs[key];
    options.cache.fallback('graph-dto-invalid');
    return undefined;
  }
  options.cache.increment('graphHits');
  return data;
}
export async function restoreGeneratedGraph(
  options: GraphRestoreInput & {
    preparation: PrepareGeneratedTsconfigGraphOptions;
  },
): Promise<GeneratedTsconfigGraphResult | undefined> {
  const data = await readGraph(options);
  return data === undefined ? undefined : rebindArtifacts(data, options);
}
export async function restoreCachedDependencyAnalysis(
  config: ResolvedLiminaConfig,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<DependencyAnalysisResult | undefined> {
  const cache = options.projectDependencyCaches?.analysisCache;
  return cache === undefined
    ? undefined
    : restoredAnalysis(cache, config, options);
}
async function restoredAnalysis(
  cache: NativeAnalysisCache,
  config: ResolvedLiminaConfig,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<DependencyAnalysisResult | undefined> {
  return (
    await readGraph({
      cache,
      config,
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
  config: ResolvedLiminaConfig;
  workspace: ValidatedWorkspaceContext;
  result: GeneratedTsconfigGraphResult;
  analysis: DependencyAnalysisResult;
}): void {
  const version = versions(options.config, options.workspace);
  if (version === undefined) {
    options.cache.fallback(graphFallbackReason(options.config));
    return;
  }
  if (
    options.result.checkers.some(
      (checker) => !['tsc', 'tsgo'].includes(checker.name),
    )
  ) {
    options.cache.fallback('graph-framework');
    return;
  }
  options.cache.captureLiveContexts();
  const value: Partial<GeneratedTsconfigGraphResult> & {
    dependencyAnalysis: DependencyAnalysisResult;
  } = { ...options.result, dependencyAnalysis: options.analysis };
  delete value.artifactPlan;
  delete value.changed;
  // Runtime authority never crosses the persistence boundary.
  options.cache.captureGraphRecord(key, { ...version, value });
}
