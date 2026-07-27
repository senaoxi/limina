import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'pathe';
import {
  collectDependencyGraph,
  type DependencyGraphDocument,
  stringifyDependencyGraph,
} from '../dependency-graph/runner';
import { resolvePreflight } from '../preflight';
import { runReferenceCompletenessPhase } from './completeness-phase';
import { runConditionDomainPhase } from './condition-phase';
import { runProjectReferencePhase } from './reference-phase';
import { finishGraphCheck } from './result-reporting';
import { runGraphRoutePhase } from './route-phase';
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

export async function runGraphCheckImpl(
  config: ResolvedLiminaConfig,
  options: RunGraphCheckImplOptions = {},
): Promise<boolean> {
  const state = await createGraphCheckState(config, options);

  runGraphRoutePhase(state);
  runProjectReferencePhase(state);
  runConditionDomainPhase(state);
  runReferenceCompletenessPhase(state);
  return finishGraphCheck(state);
}

export async function runGraphPrepareImpl(
  config: ResolvedLiminaConfig,
  options: RunGraphPrepareOptions = {},
): Promise<GeneratedTsconfigGraphResult> {
  const preflight = resolvePreflight(config, options);
  return (await preflight.ensureGeneratedArtifactsMaterialized()).graph;
}

export async function runGraphExportImpl(
  config: ResolvedLiminaConfig,
  options: RunGraphExportOptions = {},
): Promise<DependencyGraphDocument> {
  const preflight = resolvePreflight(config, options);

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
}
