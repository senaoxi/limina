import type { AutoCheckerPreset } from './types';

function shouldPromoteAutoScope(options: {
  dependencies: ReadonlySet<string>;
  entryConfigPath: string;
  kindsByEntry: ReadonlyMap<string, AutoCheckerPreset>;
}): boolean {
  if (options.kindsByEntry.get(options.entryConfigPath) !== 'tsc') {
    return false;
  }
  return [...options.dependencies].some(
    (dependencyPath) => options.kindsByEntry.get(dependencyPath) === 'vue-tsc',
  );
}

function promoteAutoScopePass(options: {
  dependenciesByEntry: ReadonlyMap<string, Set<string>>;
  kindsByEntry: Map<string, AutoCheckerPreset>;
}): boolean {
  let changed = false;
  for (const [entryConfigPath, dependencies] of options.dependenciesByEntry) {
    if (
      shouldPromoteAutoScope({
        dependencies,
        entryConfigPath,
        kindsByEntry: options.kindsByEntry,
      })
    ) {
      options.kindsByEntry.set(entryConfigPath, 'vue-tsc');
      changed = true;
    }
  }
  return changed;
}

export function promoteAutoScopes(options: {
  dependenciesByEntry: ReadonlyMap<string, Set<string>>;
  kindsByEntry: Map<string, AutoCheckerPreset>;
}): void {
  while (promoteAutoScopePass(options)) {
    // Repeat until the transitive checker capability reaches a fixed point.
  }
}
