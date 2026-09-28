import type { GeneratedDependencyEdge } from '#core/build-graph/runner';
import { collectStronglyConnectedComponents } from '#utils/strongly-connected-components';
import type { TypecheckTarget } from '../targets';
import { assertNoDeclarationCycles } from './declaration-cycle';
import {
  createComponentDependencies,
  resolveComponentTargets,
} from './dependency-components';
import { createComponentLayers } from './dependency-layers';

export interface BuildDependencyPlan {
  components: TypecheckTarget[][];
  dependenciesByComponentIndex: Map<number, Set<number>>;
  layers: number[][];
}

interface TargetDependencyContext {
  declarationDependenciesByTargetKey: Map<string, Set<string>>;
  dependenciesByTargetKey: Map<string, Set<string>>;
  targetKeyByTarget: ReadonlyMap<TypecheckTarget, string>;
  targets: readonly TypecheckTarget[];
}

function getBuildTargetDependencyKey(target: TypecheckTarget): string {
  return [
    target.checkerName ?? '',
    target.sourceConfigPath ?? '',
    target.configPath,
  ].join('\0');
}

function sourceConfigMatches(
  sourceConfigPath: string | undefined,
  edgeConfigPath: string,
): boolean {
  return sourceConfigPath === undefined || sourceConfigPath === edgeConfigPath;
}

function dependencyEdgeMatchesConsumer(
  edge: GeneratedDependencyEdge,
  target: TypecheckTarget,
): boolean {
  return (
    target.checkerName === edge.fromChecker &&
    sourceConfigMatches(target.sourceConfigPath, edge.fromConfigPath)
  );
}

function dependencyEdgeMatchesProvider(
  edge: GeneratedDependencyEdge,
  target: TypecheckTarget,
): boolean {
  return (
    target.checkerName === edge.toChecker &&
    sourceConfigMatches(target.sourceConfigPath, edge.toConfigPath)
  );
}

function getProviderDependencyKey(
  providerKey: string | undefined,
  consumerKey: string,
): string | null {
  if (providerKey === undefined) {
    return null;
  }

  return providerKey === consumerKey ? null : providerKey;
}

function getRequiredDependencies(
  dependenciesByTargetKey: ReadonlyMap<string, Set<string>>,
  targetKey: string,
): Set<string> {
  const dependencies = dependenciesByTargetKey.get(targetKey);
  if (dependencies === undefined) {
    throw new Error(`Missing dependency collection for target ${targetKey}.`);
  }
  return dependencies;
}

function addProviderDependency(options: {
  consumerKey: string;
  context: TargetDependencyContext;
  declaration: boolean;
  providerTarget: TypecheckTarget;
}): void {
  const providerKey = options.context.targetKeyByTarget.get(
    options.providerTarget,
  );

  const dependencyKey = getProviderDependencyKey(
    providerKey,
    options.consumerKey,
  );

  if (dependencyKey === null) {
    return;
  }

  getRequiredDependencies(
    options.context.dependenciesByTargetKey,
    options.consumerKey,
  ).add(dependencyKey);
  if (options.declaration) {
    getRequiredDependencies(
      options.context.declarationDependenciesByTargetKey,
      options.consumerKey,
    ).add(dependencyKey);
  }
}

function addConsumerDependencies(options: {
  consumerTarget: TypecheckTarget;
  context: TargetDependencyContext;
  declaration: boolean;
  providerTargets: readonly TypecheckTarget[];
}): void {
  const consumerKey = options.context.targetKeyByTarget.get(
    options.consumerTarget,
  );

  if (consumerKey === undefined) {
    return;
  }

  for (const providerTarget of options.providerTargets) {
    addProviderDependency({
      consumerKey,
      context: options.context,
      declaration: options.declaration,
      providerTarget,
    });
  }
}

function addEdgeDependencies(
  edge: GeneratedDependencyEdge,
  context: TargetDependencyContext,
): void {
  const consumerTargets = context.targets.filter((target) =>
    dependencyEdgeMatchesConsumer(edge, target),
  );
  const providerTargets = context.targets.filter((target) =>
    dependencyEdgeMatchesProvider(edge, target),
  );

  for (const consumerTarget of consumerTargets) {
    addConsumerDependencies({
      consumerTarget,
      context,
      declaration: edge.kind === 'declaration-provider',
      providerTargets,
    });
  }
}

function createTargetDependencyContext(
  targets: readonly TypecheckTarget[],
): TargetDependencyContext {
  const targetEntries = targets.map(
    (target) => [target, getBuildTargetDependencyKey(target)] as const,
  );

  return {
    declarationDependenciesByTargetKey: new Map(
      targetEntries.map(([, key]) => [key, new Set<string>()]),
    ),
    dependenciesByTargetKey: new Map(
      targetEntries.map(([, key]) => [key, new Set<string>()]),
    ),
    targetKeyByTarget: new Map(targetEntries),
    targets,
  };
}

export function createBuildDependencyPlan(
  targets: TypecheckTarget[],
  dependencyEdges: GeneratedDependencyEdge[],
): BuildDependencyPlan {
  const context = createTargetDependencyContext(targets);

  for (const edge of dependencyEdges) {
    addEdgeDependencies(edge, context);
  }

  const orderedKeys = targets.map(getBuildTargetDependencyKey);
  const components = collectStronglyConnectedComponents(
    orderedKeys,
    (key) => context.dependenciesByTargetKey.get(key) ?? [],
  );
  assertNoDeclarationCycles({
    components,
    declarationDependenciesByTargetKey:
      context.declarationDependenciesByTargetKey,
  });
  const dependenciesByComponentIndex = createComponentDependencies({
    components,
    dependenciesByTargetKey: context.dependenciesByTargetKey,
    orderedKeys,
  });
  const targetByKey = new Map(
    targets.map((target) => [getBuildTargetDependencyKey(target), target]),
  );

  return {
    components: resolveComponentTargets({ components, targetByKey }),
    dependenciesByComponentIndex,
    layers: createComponentLayers({
      componentCount: components.length,
      dependenciesByComponentIndex,
    }),
  };
}
