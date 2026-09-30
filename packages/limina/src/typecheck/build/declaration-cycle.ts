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

export function assertNoDeclarationCycles(options: {
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
