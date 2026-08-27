function targetHasDeclarationDependency(options: {
  consumer: string;
  declarationDependenciesByTargetKey: ReadonlyMap<string, ReadonlySet<string>>;
  members: ReadonlySet<string>;
}): boolean {
  const dependencies = options.declarationDependenciesByTargetKey.get(
    options.consumer,
  );
  if (dependencies === undefined) return false;
  return [...dependencies].some((provider) => options.members.has(provider));
}

function componentHasDeclarationCycle(options: {
  component: readonly string[];
  declarationDependenciesByTargetKey: ReadonlyMap<string, ReadonlySet<string>>;
}): boolean {
  if (options.component.length < 2) return false;
  const members = new Set(options.component);
  return options.component.some((consumer) =>
    targetHasDeclarationDependency({
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
    if (!componentHasDeclarationCycle({ ...options, component })) continue;
    throw new Error(
      `Declaration dependency cycle is not schedulable: ${component.join(' -> ')}`,
    );
  }
}
