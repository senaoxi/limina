import { uniqueCodeUnitSortedStrings } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { createGeneratedGraphStructuredError } from './problems';
import { collectCheckerSourceConfigModules } from './source-config-collection';
import type {
  CollectCheckerSourceConfigsOptions,
  CollectionContext,
} from './source-config-collection-types';
import type { CheckerSourceConfigCollection } from './types';

export function createEmptySourceConfigCollection(
  entryConfigPaths: readonly string[],
): CheckerSourceConfigCollection {
  const normalizedEntries = uniqueCodeUnitSortedStrings(
    entryConfigPaths.map(normalizeAbsolutePath),
  );
  return {
    buildModulesBySourcePath: new Map(),
    crossCheckerReferences: [],
    entryConfigPaths: new Set(normalizedEntries),
    packageRootBySourcePath: new Map(),
    projectConfigPaths: new Set(),
    rootConfigPaths: [],
    solutionConfigPaths: new Set(),
    solutionReferencesBySourcePath: new Map(),
  };
}

function assertCollectionSucceeded(options: {
  context: CollectionContext;
}): void {
  if (options.context.problems.length === 0) return;
  throw createGeneratedGraphStructuredError({
    config: options.context.config,
    fallback: 'Failed to collect checker source configs.',
    problems: options.context.problems,
  });
}

export function collectCheckerSourceConfigs(
  options: CollectCheckerSourceConfigsOptions,
): CheckerSourceConfigCollection {
  const collection = createEmptySourceConfigCollection(
    options.entryConfigPaths,
  );
  const context: CollectionContext = {
    ...options,
    collection,
    problems: [],
    seenConfigs: new Set(),
  };
  for (const sourceConfigPath of collection.entryConfigPaths) {
    collectCheckerSourceConfigModules({ ...context, sourceConfigPath });
  }
  assertCollectionSucceeded({ context });
  collection.rootConfigPaths = [...collection.entryConfigPaths].filter(
    (sourcePath) => collection.buildModulesBySourcePath.has(sourcePath),
  );
  return collection;
}
