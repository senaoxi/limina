import type { TypecheckTarget } from '../targets';

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

export function createComponentDependencies(options: {
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

export function resolveComponentTargets(options: {
  components: readonly (readonly string[])[];
  targetByKey: ReadonlyMap<string, TypecheckTarget>;
}): TypecheckTarget[][] {
  return options.components.map((component) =>
    component
      .map((key) => options.targetByKey.get(key))
      .filter((target): target is TypecheckTarget => target !== undefined),
  );
}
