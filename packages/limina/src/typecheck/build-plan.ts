import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedProviderEdge } from '#core/build-graph/runner';
import { resolveCheckerBuildConcurrency } from '../execution/config';
import { runPool } from '../execution/pool';
import type {
  TypecheckRunner,
  TypecheckTarget,
  TypecheckTargetResult,
} from './targets';

function getBuildTargetDependencyKey(target: TypecheckTarget): string {
  return [
    target.checkerName ?? '',
    target.sourceConfigPath ?? '',
    target.configPath,
  ].join('\0');
}

function providerEdgeMatchesConsumer(
  edge: GeneratedProviderEdge,
  target: TypecheckTarget,
): boolean {
  return (
    target.checkerName === edge.fromChecker &&
    (!target.sourceConfigPath ||
      target.sourceConfigPath === edge.fromConfigPath)
  );
}

function providerEdgeMatchesProvider(
  edge: GeneratedProviderEdge,
  target: TypecheckTarget,
): boolean {
  return (
    target.checkerName === edge.toChecker &&
    (!target.sourceConfigPath || target.sourceConfigPath === edge.toConfigPath)
  );
}

function collectStronglyConnectedBuildTargetKeys(
  orderedKeys: string[],
  dependenciesByTargetKey: Map<string, Set<string>>,
): string[][] {
  const indexByKey = new Map<string, number>();
  const lowLinkByKey = new Map<string, number>();
  const stack: string[] = [];
  const stackedKeys = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (key: string): void => {
    indexByKey.set(key, nextIndex);
    lowLinkByKey.set(key, nextIndex);
    nextIndex += 1;
    stack.push(key);
    stackedKeys.add(key);

    for (const dependencyKey of dependenciesByTargetKey.get(key) ?? []) {
      if (!indexByKey.has(dependencyKey)) {
        visit(dependencyKey);
        lowLinkByKey.set(
          key,
          Math.min(
            lowLinkByKey.get(key) ?? 0,
            lowLinkByKey.get(dependencyKey) ?? 0,
          ),
        );
      } else if (stackedKeys.has(dependencyKey)) {
        lowLinkByKey.set(
          key,
          Math.min(
            lowLinkByKey.get(key) ?? 0,
            indexByKey.get(dependencyKey) ?? 0,
          ),
        );
      }
    }

    if (lowLinkByKey.get(key) !== indexByKey.get(key)) {
      return;
    }

    const component: string[] = [];

    while (stack.length > 0) {
      const componentKey = stack.pop()!;

      stackedKeys.delete(componentKey);
      component.push(componentKey);

      if (componentKey === key) {
        break;
      }
    }

    components.push(component);
  };

  for (const key of orderedKeys) {
    if (!indexByKey.has(key)) {
      visit(key);
    }
  }

  return components
    .map((component) =>
      component.sort(
        (left, right) => orderedKeys.indexOf(left) - orderedKeys.indexOf(right),
      ),
    )
    .sort(
      (left, right) =>
        orderedKeys.indexOf(left[0]!) - orderedKeys.indexOf(right[0]!),
    );
}

function createBuildDependencyLayers(
  targets: TypecheckTarget[],
  providerEdges: GeneratedProviderEdge[],
): TypecheckTarget[][] {
  const targetKeyByTarget = new Map<TypecheckTarget, string>(
    targets.map((target) => [target, getBuildTargetDependencyKey(target)]),
  );
  const targetByKey = new Map<string, TypecheckTarget>(
    targets.map((target) => [getBuildTargetDependencyKey(target), target]),
  );
  const dependenciesByTargetKey = new Map<string, Set<string>>(
    targets.map((target) => [getBuildTargetDependencyKey(target), new Set()]),
  );

  for (const edge of providerEdges) {
    const consumerTargets = targets.filter((target) =>
      providerEdgeMatchesConsumer(edge, target),
    );
    const providerTargets = targets.filter((target) =>
      providerEdgeMatchesProvider(edge, target),
    );

    for (const consumerTarget of consumerTargets) {
      const consumerKey = targetKeyByTarget.get(consumerTarget);

      if (!consumerKey) {
        continue;
      }

      for (const providerTarget of providerTargets) {
        const providerKey = targetKeyByTarget.get(providerTarget);

        if (!providerKey || providerKey === consumerKey) {
          continue;
        }

        dependenciesByTargetKey.get(consumerKey)?.add(providerKey);
      }
    }
  }

  const orderedKeys = targets.map(getBuildTargetDependencyKey);
  const components = collectStronglyConnectedBuildTargetKeys(
    orderedKeys,
    dependenciesByTargetKey,
  );
  const componentIndexByKey = new Map<string, number>();

  for (const [componentIndex, component] of components.entries()) {
    for (const key of component) {
      componentIndexByKey.set(key, componentIndex);
    }
  }

  const dependenciesByComponentIndex = new Map<number, Set<number>>(
    components.map((_, index) => [index, new Set<number>()]),
  );

  for (const key of orderedKeys) {
    const componentIndex = componentIndexByKey.get(key);

    if (componentIndex === undefined) {
      continue;
    }

    for (const dependencyKey of dependenciesByTargetKey.get(key) ?? []) {
      const dependencyComponentIndex = componentIndexByKey.get(dependencyKey);

      if (
        dependencyComponentIndex === undefined ||
        dependencyComponentIndex === componentIndex
      ) {
        continue;
      }

      dependenciesByComponentIndex
        .get(componentIndex)
        ?.add(dependencyComponentIndex);
    }
  }

  const remainingComponentIndexes = new Set(
    components.map((_, index) => index),
  );
  const completedComponentIndexes = new Set<number>();
  const layers: TypecheckTarget[][] = [];

  while (remainingComponentIndexes.size > 0) {
    const readyComponentIndexes = components
      .map((_, index) => index)
      .filter((componentIndex) => {
        if (!remainingComponentIndexes.has(componentIndex)) {
          return false;
        }

        const dependencies =
          dependenciesByComponentIndex.get(componentIndex) ?? new Set();

        return [...dependencies].every((dependency) =>
          completedComponentIndexes.has(dependency),
        );
      });

    if (readyComponentIndexes.length === 0) {
      break;
    }

    layers.push(
      readyComponentIndexes
        .flatMap((componentIndex) => components[componentIndex] ?? [])
        .map((key) => targetByKey.get(key))
        .filter((target): target is TypecheckTarget => Boolean(target)),
    );

    for (const componentIndex of readyComponentIndexes) {
      remainingComponentIndexes.delete(componentIndex);
      completedComponentIndexes.add(componentIndex);
    }
  }

  if (remainingComponentIndexes.size > 0) {
    layers.push(
      [...remainingComponentIndexes]
        .flatMap((componentIndex) => components[componentIndex] ?? [])
        .map((key) => targetByKey.get(key))
        .filter((target): target is TypecheckTarget => Boolean(target)),
    );
  }

  return layers;
}

export async function runBuildTargets(
  targets: TypecheckTarget[],
  providerEdges: GeneratedProviderEdge[],
  runner: TypecheckRunner,
  options: {
    config: ResolvedLiminaConfig;
    onTargetResult?: (
      target: TypecheckTarget,
      result: TypecheckTargetResult,
    ) => void;
    onTargetStart?: (target: TypecheckTarget) => void;
    watch?: boolean;
  },
): Promise<TypecheckTargetResult[]> {
  const results: TypecheckTargetResult[] = [];
  const layers = options.watch
    ? [targets]
    : createBuildDependencyLayers(targets, providerEdges);

  for (const layer of layers) {
    if (layer.length === 0) {
      continue;
    }

    results.push(
      ...(await runPool<TypecheckTarget, TypecheckTargetResult>({
        concurrency: options.watch
          ? layer.length
          : resolveCheckerBuildConcurrency({
              config: options.config,
              itemCount: layer.length,
            }),
        items: layer,
        onError: (target, error) => ({
          configPath: target.configPath,
          durationMs: 0,
          error: error instanceof Error ? error : new Error(String(error)),
          status: 1,
        }),
        onResult: options.onTargetResult,
        onStart: options.onTargetStart,
        run: async (target) => {
          const startedAt = performance.now();

          return {
            ...(await runner(target)),
            durationMs: performance.now() - startedAt,
          };
        },
      })),
    );
  }

  return results;
}
