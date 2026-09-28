function findEligibleProvider(options: {
  dependencies: ReadonlySet<string>;
  isEligibleProvider: (providerPath: string) => boolean;
}): string | undefined {
  return [...options.dependencies].find(options.isEligibleProvider);
}

function promoteDirectedConsumer(options: {
  consumerPath: string;
  dependencies: ReadonlySet<string>;
  isEligibleProvider: (providerPath: string) => boolean;
  promoteConsumer: (consumerPath: string, providerPath: string) => boolean;
}): boolean {
  const providerPath = findEligibleProvider(options);
  if (providerPath === undefined) return false;
  return options.promoteConsumer(options.consumerPath, providerPath);
}

function promoteDirectedPass(options: {
  dependenciesByConsumer: ReadonlyMap<string, Set<string>>;
  isEligibleProvider: (providerPath: string) => boolean;
  promoteConsumer: (consumerPath: string, providerPath: string) => boolean;
}): boolean {
  let changed = false;
  for (const [consumerPath, dependencies] of options.dependenciesByConsumer) {
    if (
      promoteDirectedConsumer({
        consumerPath,
        dependencies,
        isEligibleProvider: options.isEligibleProvider,
        promoteConsumer: options.promoteConsumer,
      })
    )
      changed = true;
  }
  return changed;
}

export function promoteDirectedCheckerDependencies(options: {
  dependenciesByConsumer: ReadonlyMap<string, Set<string>>;
  isEligibleProvider: (providerPath: string) => boolean;
  onPass: () => void;
  promoteConsumer: (consumerPath: string, providerPath: string) => boolean;
}): void {
  while (promoteDirectedPass(options)) {
    options.onPass();
  }
}
