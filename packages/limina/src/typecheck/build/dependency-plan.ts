import type { GeneratedDependencyEdge } from '#core/build-graph/runner';
import { collectStronglyConnectedComponents } from '#utils/strongly-connected-components';
import type { CheckerTargetId, TypecheckTarget } from '../targets';

export interface BuildDependencyPlan {
  components: TypecheckTarget[][];
  executionDependenciesByTargetId?: Map<CheckerTargetId, CheckerTargetId[]>;
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

function isSourceConfigMatches(
  sourceConfigPath: string | undefined,
  edgeConfigPath: string,
): boolean {
  return sourceConfigPath === undefined || sourceConfigPath === edgeConfigPath;
}

function isDependencyEdgeMatchesConsumer(
  edge: GeneratedDependencyEdge,
  target: TypecheckTarget,
): boolean {
  return 'consumerTargetId' in edge
    ? edge.consumerTargetId === target.id
    : target.checkerName === edge.fromChecker &&
        isSourceConfigMatches(target.sourceConfigPath, edge.fromConfigPath);
}

function isDependencyEdgeMatchesProvider(
  edge: GeneratedDependencyEdge,
  target: TypecheckTarget,
): boolean {
  return 'providerTargetId' in edge
    ? edge.providerTargetId === target.id
    : target.checkerName === edge.toChecker &&
        isSourceConfigMatches(target.sourceConfigPath, edge.toConfigPath);
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
    isDependencyEdgeMatchesConsumer(edge, target),
  );
  const providerTargets = context.targets.filter((target) =>
    isDependencyEdgeMatchesProvider(edge, target),
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
  executionPrerequisites: GeneratedDependencyEdge[] = [],
): BuildDependencyPlan {
  const context = createTargetDependencyContext(targets);

  for (const edge of [...dependencyEdges, ...executionPrerequisites]) {
    addEdgeDependencies(edge, context);
  }

  const execution = executionDependencies(targets, executionPrerequisites);
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
    executionDependenciesByTargetId: targetPrerequisites(
      execution,
      targetByKey,
    ),
    dependenciesByComponentIndex,
    layers: createComponentLayers({
      componentCount: components.length,
      dependenciesByComponentIndex,
    }),
  };
}

function executionDependencies(
  targets: TypecheckTarget[],
  edges: GeneratedDependencyEdge[],
): TargetDependencyContext {
  const context = createTargetDependencyContext(targets);
  for (const edge of edges) addEdgeDependencies(edge, context);
  return context;
}

function targetPrerequisites(
  context: TargetDependencyContext,
  targets: ReadonlyMap<string, TypecheckTarget>,
): Map<CheckerTargetId, CheckerTargetId[]> {
  return new Map(
    context.targets.map((target) => [
      target.id,
      [
        ...(context.dependenciesByTargetKey.get(
          getBuildTargetDependencyKey(target),
        ) ?? []),
      ].map((key) => targets.get(key)!.id),
    ]),
  );
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

function getDependencies(
  dependencies: ReadonlySet<number> | undefined,
): ReadonlySet<number> {
  return dependencies === undefined ? new Set<number>() : dependencies;
}

function isDependenciesAreCompleted(options: {
  completed: ReadonlySet<number>;
  dependencies: ReadonlySet<number> | undefined;
}): boolean {
  return [...getDependencies(options.dependencies)].every((dependency) =>
    options.completed.has(dependency),
  );
}

function isReadyComponent(options: {
  completed: ReadonlySet<number>;
  componentIndex: number;
  dependenciesByComponentIndex: ReadonlyMap<number, ReadonlySet<number>>;
  remaining: ReadonlySet<number>;
}): boolean {
  if (!options.remaining.has(options.componentIndex)) {
    return false;
  }

  return isDependenciesAreCompleted({
    completed: options.completed,
    dependencies: options.dependenciesByComponentIndex.get(
      options.componentIndex,
    ),
  });
}

function createComponentIndexes(componentCount: number): number[] {
  return Array.from({ length: componentCount }, (_, index) => index);
}

function collectReadyComponents(options: {
  completed: ReadonlySet<number>;
  componentCount: number;
  dependenciesByComponentIndex: ReadonlyMap<number, ReadonlySet<number>>;
  remaining: ReadonlySet<number>;
}): number[] {
  return createComponentIndexes(options.componentCount).filter(
    (componentIndex) =>
      isReadyComponent({
        completed: options.completed,
        componentIndex,
        dependenciesByComponentIndex: options.dependenciesByComponentIndex,
        remaining: options.remaining,
      }),
  );
}

function completeLayer(options: {
  completed: Set<number>;
  layer: readonly number[];
  remaining: Set<number>;
}): void {
  for (const componentIndex of options.layer) {
    options.remaining.delete(componentIndex);
    options.completed.add(componentIndex);
  }
}

function createComponentLayers(options: {
  componentCount: number;
  dependenciesByComponentIndex: ReadonlyMap<number, ReadonlySet<number>>;
}): number[][] {
  const remaining = new Set(createComponentIndexes(options.componentCount));
  const completed = new Set<number>();
  const layers: number[][] = [];

  while (remaining.size > 0) {
    const layer = collectReadyComponents({
      completed,
      componentCount: options.componentCount,
      dependenciesByComponentIndex: options.dependenciesByComponentIndex,
      remaining,
    });

    if (layer.length === 0) {
      layers.push([...remaining]);
      return layers;
    }

    layers.push(layer);
    completeLayer({ completed, layer, remaining });
  }

  return layers;
}

function isTargetHasDeclarationDependency(options: {
  consumer: string;
  declarationDependenciesByTargetKey: ReadonlyMap<string, ReadonlySet<string>>;
  members: ReadonlySet<string>;
}): boolean {
  const dependencies = options.declarationDependenciesByTargetKey.get(
    options.consumer,
  );
  return (
    dependencies !== undefined &&
    [...dependencies].some((provider) => options.members.has(provider))
  );
}

function isComponentHasDeclarationCycle(options: {
  component: readonly string[];
  declarationDependenciesByTargetKey: ReadonlyMap<string, ReadonlySet<string>>;
}): boolean {
  if (options.component.length < 2) return false;
  const members = new Set(options.component);
  return options.component.some((consumer) =>
    isTargetHasDeclarationDependency({
      consumer,
      declarationDependenciesByTargetKey:
        options.declarationDependenciesByTargetKey,
      members,
    }),
  );
}

function assertNoDeclarationCycles(options: {
  components: readonly (readonly string[])[];
  declarationDependenciesByTargetKey: ReadonlyMap<string, ReadonlySet<string>>;
}): void {
  for (const component of options.components) {
    if (!isComponentHasDeclarationCycle({ ...options, component })) continue;
    throw new Error(
      `Declaration dependency cycle is not schedulable: ${component.join(' -> ')}`,
    );
  }
}
