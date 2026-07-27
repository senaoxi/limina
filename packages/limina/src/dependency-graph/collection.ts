import type { ResolvedLiminaConfig } from '#config/runner';
import { collectDependencyGraphEdges } from './edge-collector';
import { createNodes, sortEdges } from './model';
import {
  assertDependencyGraphProblemsEmpty,
  createDependencyGraphCollectionContext,
} from './setup';
import type {
  CollectDependencyGraphOptions,
  DependencyGraphDocument,
} from './types';

export async function collectDependencyGraph(
  config: ResolvedLiminaConfig,
  options: CollectDependencyGraphOptions = {},
): Promise<DependencyGraphDocument> {
  const context = await createDependencyGraphCollectionContext({
    config,
    graphOptions: options,
  });
  collectDependencyGraphEdges(context);
  assertDependencyGraphProblemsEmpty(context);
  return {
    edges: sortEdges([...context.edgesByKey.values()]),
    nodes: createNodes(config, context.workspacePackages),
    rootDir: '.',
    schemaVersion: 1,
    view: context.view,
  };
}

export function stringifyDependencyGraph(
  graph: DependencyGraphDocument,
): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}
