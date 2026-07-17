import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedProviderEdge } from '#core/build-graph/runner';
import { resolveCheckerBuildConcurrency } from '../execution/config';
import { runPool } from '../execution/pool';
import {
  type CheckerTargetId,
  runTargetWithMeasuredDuration,
  type TypecheckRunner,
  type TypecheckTarget,
  type TypecheckTargetResult,
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

function createBuildDependencyPlan(
  targets: TypecheckTarget[],
  providerEdges: GeneratedProviderEdge[],
): {
  components: TypecheckTarget[][];
  dependenciesByComponentIndex: Map<number, Set<number>>;
  layers: number[][];
} {
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

  const componentTargets = components.map((component) =>
    component
      .map((key) => targetByKey.get(key))
      .filter((target): target is TypecheckTarget => Boolean(target)),
  );

  const remainingComponentIndexes = new Set(
    components.map((_, index) => index),
  );
  const completedComponentIndexes = new Set<number>();
  const layers: number[][] = [];

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

    layers.push(readyComponentIndexes);

    for (const componentIndex of readyComponentIndexes) {
      remainingComponentIndexes.delete(componentIndex);
      completedComponentIndexes.add(componentIndex);
    }
  }

  if (remainingComponentIndexes.size > 0) {
    layers.push([...remainingComponentIndexes]);
  }

  return {
    components: componentTargets,
    dependenciesByComponentIndex,
    layers,
  };
}

export async function runBuildTargets(
  targets: TypecheckTarget[],
  providerEdges: GeneratedProviderEdge[],
  runner: TypecheckRunner,
  options: {
    beforeLayerRun?: (targets: readonly TypecheckTarget[]) => Promise<void>;
    beforeTargetRun?: (target: TypecheckTarget) => Promise<void>;
    config: ResolvedLiminaConfig;
    onTargetResult?: (
      target: TypecheckTarget,
      result: TypecheckTargetResult,
    ) => void;
    onTargetStart?: (target: TypecheckTarget) => void;
    watch?: boolean;
  },
): Promise<TypecheckTargetResult[]> {
  const resultsByTargetId = new Map<CheckerTargetId, TypecheckTargetResult>();
  const targetOrderById = new Map(
    targets.map((target, index) => [target.id, index]),
  );
  const buildPlan = options.watch
    ? {
        components: [targets],
        dependenciesByComponentIndex: new Map([[0, new Set<number>()]]),
        layers: [[0]],
      }
    : createBuildDependencyPlan(targets, providerEdges);
  const failureRootsByComponentIndex = new Map<
    number,
    readonly CheckerTargetId[]
  >();
  const stableRoots = (roots: Iterable<CheckerTargetId>): CheckerTargetId[] =>
    [...new Set(roots)].sort(
      (left, right) =>
        (targetOrderById.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (targetOrderById.get(right) ?? Number.MAX_SAFE_INTEGER),
    );

  for (const layer of buildPlan.layers) {
    if (layer.length === 0) {
      continue;
    }

    const runnableComponentIndexes: number[] = [];
    const runnableTargets: TypecheckTarget[] = [];
    for (const componentIndex of layer) {
      const componentTargets = buildPlan.components[componentIndex] ?? [];
      const upstreamRoots = stableRoots(
        [
          ...(buildPlan.dependenciesByComponentIndex.get(componentIndex) ?? []),
        ].flatMap(
          (dependencyIndex) =>
            failureRootsByComponentIndex.get(dependencyIndex) ?? [],
        ),
      );
      if (upstreamRoots.length === 0 || options.watch) {
        runnableComponentIndexes.push(componentIndex);
        runnableTargets.push(...componentTargets);
        continue;
      }

      failureRootsByComponentIndex.set(componentIndex, upstreamRoots);
      for (const target of componentTargets) {
        const blockedResult: TypecheckTargetResult = {
          blockedBy: upstreamRoots,
          configPath: target.configPath,
          durationMs: 0,
          id: target.id,
          status: 1,
        };
        resultsByTargetId.set(target.id, blockedResult);
        options.onTargetResult?.(target, blockedResult);
      }
    }

    let layerResults: TypecheckTargetResult[] = [];
    if (runnableTargets.length > 0) {
      try {
        await options.beforeLayerRun?.(runnableTargets);
      } catch (error) {
        layerResults = runnableTargets.map((target) => {
          const result: TypecheckTargetResult = {
            configPath: target.configPath,
            durationMs: 0,
            error: error instanceof Error ? error : new Error(String(error)),
            id: target.id,
            status: 1,
          };
          options.onTargetResult?.(target, result);
          return result;
        });
      }
    }
    if (runnableTargets.length > 0 && layerResults.length === 0) {
      layerResults = await runPool<TypecheckTarget, TypecheckTargetResult>({
        concurrency: options.watch
          ? runnableTargets.length
          : resolveCheckerBuildConcurrency({
              config: options.config,
              itemCount: runnableTargets.length,
            }),
        items: runnableTargets,
        onError: (target, error) => ({
          configPath: target.configPath,
          durationMs: 0,
          error: error instanceof Error ? error : new Error(String(error)),
          id: target.id,
          status: 1,
        }),
        onResult: options.onTargetResult,
        run: async (target) => {
          await options.beforeTargetRun?.(target);
          options.onTargetStart?.(target);
          return runTargetWithMeasuredDuration(runner, target);
        },
      });
    }
    for (const result of layerResults) {
      resultsByTargetId.set(result.id, result);
    }
    for (const componentIndex of runnableComponentIndexes) {
      const componentTargets = buildPlan.components[componentIndex] ?? [];
      failureRootsByComponentIndex.set(
        componentIndex,
        stableRoots(
          componentTargets
            .filter((target) => resultsByTargetId.get(target.id)?.status !== 0)
            .map((target) => target.id),
        ),
      );
    }
  }

  return targets.map((target) => {
    const result = resultsByTargetId.get(target.id);
    if (!result) {
      throw new Error(`Missing checker target result for ${target.id}.`);
    }
    return result;
  });
}
