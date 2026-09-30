function findEligibleProvider(options: {
  dependencies: ReadonlySet<string>;
  isEligibleProvider: (providerPath: string) => boolean;
}): string | undefined {
  return [...options.dependencies].find(options.isEligibleProvider);
}

function isPromoteDirectedConsumer(options: {
  consumerPath: string;
  dependencies: ReadonlySet<string>;
  isEligibleProvider: (providerPath: string) => boolean;
  promoteConsumer: (consumerPath: string, providerPath: string) => boolean;
}): boolean {
  const providerPath = findEligibleProvider(options);
  return (
    providerPath !== undefined &&
    options.promoteConsumer(options.consumerPath, providerPath)
  );
}

function isPromoteDirectedPass(options: {
  dependenciesByConsumer: ReadonlyMap<string, Set<string>>;
  isEligibleProvider: (providerPath: string) => boolean;
  promoteConsumer: (consumerPath: string, providerPath: string) => boolean;
}): boolean {
  let isChanged = false;
  for (const [consumerPath, dependencies] of options.dependenciesByConsumer) {
    if (
      isPromoteDirectedConsumer({
        consumerPath,
        dependencies,
        isEligibleProvider: options.isEligibleProvider,
        promoteConsumer: options.promoteConsumer,
      })
    )
      isChanged = true;
  }
  return isChanged;
}

export function promoteDirectedCheckerDependencies(options: {
  dependenciesByConsumer: ReadonlyMap<string, Set<string>>;
  isEligibleProvider: (providerPath: string) => boolean;
  onPass: () => void;
  promoteConsumer: (consumerPath: string, providerPath: string) => boolean;
}): void {
  while (isPromoteDirectedPass(options)) {
    options.onPass();
  }
}
