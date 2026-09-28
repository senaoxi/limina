function getDependencies(
  dependencies: ReadonlySet<number> | undefined,
): ReadonlySet<number> {
  return dependencies === undefined ? new Set<number>() : dependencies;
}

function dependenciesAreCompleted(options: {
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

  return dependenciesAreCompleted({
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

export function createComponentLayers(options: {
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
