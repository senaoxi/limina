import type { GeneratedProviderEdge } from '#core/build-graph/runner';
import { collectStronglyConnectedComponents } from '#utils/strongly-connected-components';
import type { TypecheckTarget } from '../targets';
import { createComponentLayers } from './dependency-layers';

export interface BuildDependencyPlan {
  components: TypecheckTarget[][];
  dependenciesByComponentIndex: Map<number, Set<number>>;
  layers: number[][];
}

interface TargetDependencyContext {
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

function providerEdgeMatchesConsumer(
  edge: GeneratedProviderEdge,
  target: TypecheckTarget,
): boolean {
  return (
    target.checkerName === edge.fromChecker &&
    sourceConfigMatches(target.sourceConfigPath, edge.fromConfigPath)
  );
}

function providerEdgeMatchesProvider(
  edge: GeneratedProviderEdge,
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

function addProviderDependency(options: {
  consumerKey: string;
  context: TargetDependencyContext;
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

  options.context.dependenciesByTargetKey
    .get(options.consumerKey)
    ?.add(dependencyKey);
}

function addConsumerDependencies(options: {
  consumerTarget: TypecheckTarget;
  context: TargetDependencyContext;
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
      providerTarget,
    });
  }
}

function addEdgeDependencies(
  edge: GeneratedProviderEdge,
  context: TargetDependencyContext,
): void {
  const consumerTargets = context.targets.filter((target) =>
    providerEdgeMatchesConsumer(edge, target),
  );
  const providerTargets = context.targets.filter((target) =>
    providerEdgeMatchesProvider(edge, target),
  );

  for (const consumerTarget of consumerTargets) {
    addConsumerDependencies({ consumerTarget, context, providerTargets });
  }
}

function createTargetDependencyContext(
  targets: readonly TypecheckTarget[],
): TargetDependencyContext {
  const targetEntries = targets.map(
    (target) => [target, getBuildTargetDependencyKey(target)] as const,
  );

  return {
    dependenciesByTargetKey: new Map(
      targetEntries.map(([, key]) => [key, new Set<string>()]),
    ),
    targetKeyByTarget: new Map(targetEntries),
    targets,
  };
}

function createComponentIndex(
  components: readonly (readonly string[])[],
): Map<string, number> {
  const componentIndexByKey = new Map<string, number>();

  for (const [componentIndex, component] of components.entries()) {
    for (const key of component) {
      componentIndexByKey.set(key, componentIndex);
    }
  }

  return componentIndexByKey;
}

function getDependencyComponentIndex(
  dependencyComponentIndex: number | undefined,
  componentIndex: number,
): number | null {
  if (dependencyComponentIndex === undefined) {
    return null;
  }

  return dependencyComponentIndex === componentIndex
    ? null
    : dependencyComponentIndex;
}

function addComponentDependency(options: {
  componentIndex: number;
  dependenciesByComponentIndex: Map<number, Set<number>>;
  dependencyComponentIndex: number | undefined;
}): void {
  const dependencyComponentIndex = getDependencyComponentIndex(
    options.dependencyComponentIndex,
    options.componentIndex,
  );

  if (dependencyComponentIndex === null) {
    return;
  }

  options.dependenciesByComponentIndex
    .get(options.componentIndex)
    ?.add(dependencyComponentIndex);
}

function getTargetDependencies(
  dependenciesByTargetKey: ReadonlyMap<string, ReadonlySet<string>>,
  key: string,
): ReadonlySet<string> {
  const dependencies = dependenciesByTargetKey.get(key);
  return dependencies === undefined ? new Set<string>() : dependencies;
}

function addTargetComponentDependencies(options: {
  componentIndexByKey: ReadonlyMap<string, number>;
  dependenciesByComponentIndex: Map<number, Set<number>>;
  dependenciesByTargetKey: ReadonlyMap<string, ReadonlySet<string>>;
  key: string;
}): void {
  const componentIndex = options.componentIndexByKey.get(options.key);

  if (componentIndex === undefined) {
    return;
  }

  const dependencyKeys = getTargetDependencies(
    options.dependenciesByTargetKey,
    options.key,
  );

  for (const dependencyKey of dependencyKeys) {
    addComponentDependency({
      componentIndex,
      dependenciesByComponentIndex: options.dependenciesByComponentIndex,
      dependencyComponentIndex: options.componentIndexByKey.get(dependencyKey),
    });
  }
}

function createComponentDependencies(options: {
  components: readonly (readonly string[])[];
  dependenciesByTargetKey: ReadonlyMap<string, ReadonlySet<string>>;
  orderedKeys: readonly string[];
}): Map<number, Set<number>> {
  const componentIndexByKey = createComponentIndex(options.components);
  const dependenciesByComponentIndex = new Map<number, Set<number>>(
    options.components.map((_, index) => [index, new Set<number>()]),
  );

  for (const key of options.orderedKeys) {
    addTargetComponentDependencies({
      componentIndexByKey,
      dependenciesByComponentIndex,
      dependenciesByTargetKey: options.dependenciesByTargetKey,
      key,
    });
  }

  return dependenciesByComponentIndex;
}

function resolveComponentTargets(options: {
  components: readonly (readonly string[])[];
  targetByKey: ReadonlyMap<string, TypecheckTarget>;
}): TypecheckTarget[][] {
  return options.components.map((component) =>
    component
      .map((key) => options.targetByKey.get(key))
      .filter((target): target is TypecheckTarget => target !== undefined),
  );
}

export function createBuildDependencyPlan(
  targets: TypecheckTarget[],
  providerEdges: GeneratedProviderEdge[],
): BuildDependencyPlan {
  const context = createTargetDependencyContext(targets);

  for (const edge of providerEdges) {
    addEdgeDependencies(edge, context);
  }

  const orderedKeys = targets.map(getBuildTargetDependencyKey);
  const components = collectStronglyConnectedComponents(
    orderedKeys,
    (key) => context.dependenciesByTargetKey.get(key) ?? [],
  );
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
