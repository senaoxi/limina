import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { LiminaStructuredError } from '../check-reporting/errors';
import {
  collectDependencyGraph,
  type DependencyGraphDocument,
  stringifyDependencyGraph,
} from '../dependency-graph/runner';
import { measureGraphMaterialization } from '../execution/graph-materialization-progress';
import { measureTaskProgress } from '../execution/progress';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import {
  runGraphRoutePhase,
  runProjectReferencePhase,
  runReferenceCompletenessPhase,
} from './phases';
import {
  isFinishGraphCheck,
  isReportGraphPreparationFailure,
} from './result-reporting';
import { createGraphCheckState } from './run-state';
import type {
  RunGraphCheckImplOptions,
  RunGraphExportOptions,
  RunGraphPrepareOptions,
} from './runner-types';

export type {
  RunGraphCheckOptions,
  RunGraphExportOptions,
  RunGraphPrepareOptions,
} from './runner-types';

export async function isRunGraphCheckImpl(
  config: ResolvedLiminaConfig,
  options: RunGraphCheckImplOptions = {},
): Promise<boolean> {
  let state;
  try {
    state = await measureTaskProgress(
      options.progress,
      'prepare graph check inputs',
      () => createGraphCheckState(config, options),
    );
  } catch (error) {
    if (
      error instanceof LiminaStructuredError &&
      error.issues.some(
        (issue) => issue.code === LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle,
      )
    )
      return isReportGraphPreparationFailure(options, error.issues);
    throw error;
  }

  try {
    runGraphRoutePhase(state);
    runProjectReferencePhase(state);
    runReferenceCompletenessPhase(state);
  } catch (error) {
    return state.checkItems.failActive(error);
  }
  return isFinishGraphCheck(state);
}

export async function runGraphPrepareImpl(
  config: ResolvedLiminaConfig,
  options: RunGraphPrepareOptions = {},
): Promise<GeneratedTsconfigGraphResult> {
  const preflight = resolvePreflight(config, options);
  const receipt = await measureGraphMaterialization({
    materialize: (onAccess) =>
      preflight.ensureGeneratedArtifactsMaterialized(onAccess),
    progress: options.progress,
    purpose: 'complete',
  });
  return receipt.graph;
}

function disposeOwnedGraphExportPreflight(
  preflight: LiminaPreflightManager,
  options: RunGraphExportOptions,
): void {
  // Caller-supplied managers and providers retain their caller-owned lifetime.
  if (options.preflight === undefined && options.providers === undefined) {
    preflight.dispose();
  }
}

export async function runGraphExportImpl(
  config: ResolvedLiminaConfig,
  options: RunGraphExportOptions = {},
): Promise<DependencyGraphDocument> {
  const preflight = resolvePreflight(config, options);

  try {
    await preflight.ensureWorkspaceValidated();
    const graph = await collectDependencyGraph(config, {
      providers: preflight.providers,
      view: options.view,
    });

    if (options.outputPath) {
      await mkdir(path.dirname(options.outputPath), { recursive: true });
      await writeFile(options.outputPath, stringifyDependencyGraph(graph));
    }

    return graph;
  } finally {
    disposeOwnedGraphExportPreflight(preflight, options);
  }
}
