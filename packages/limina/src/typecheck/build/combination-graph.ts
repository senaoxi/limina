import type { ResolvedCheckerConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  collectGraphProjectRouteFromRoot,
  getRawReferencePathsForConfig,
  isDtsConfigPath,
} from '#core/tsconfig/actions';
import type { BuildCheckerCombinationEntry } from './combination-warning';

export interface CheckerCombinationRoot {
  checker: ResolvedCheckerConfig;
  configPath: string;
  entryConfigPath: string;
}

function getSourceConfigPathForGeneratedDts(options: {
  dtsConfigPath: string;
  generatedGraph: GeneratedTsconfigGraphResult;
}): string | null {
  for (const dtsToSource of options.generatedGraph.dtsToSource.values()) {
    const sourceConfigPath = dtsToSource.get(options.dtsConfigPath);
    if (sourceConfigPath !== undefined) return sourceConfigPath;
  }
  return null;
}

function findSourceInBuildMap(options: {
  configPath: string;
  sourceToBuild: NonNullable<
    ReturnType<GeneratedTsconfigGraphResult['sourceToBuild']['get']>
  >;
}): string | null {
  for (const [sourceConfigPath, buildModule] of options.sourceToBuild) {
    if (buildModule.path === options.configPath) return sourceConfigPath;
  }
  return null;
}

function findBuildSourceConfig(options: {
  checkerName: string;
  configPath: string;
  generatedGraph: GeneratedTsconfigGraphResult;
}): string | null {
  const sourceToBuild = options.generatedGraph.sourceToBuild.get(
    options.checkerName,
  );
  if (sourceToBuild === undefined) return null;
  return findSourceInBuildMap({
    configPath: options.configPath,
    sourceToBuild,
  });
}

function getSourceConfigPathForBuildConfig(options: {
  checkerName: string;
  configPath: string;
  generatedGraph: GeneratedTsconfigGraphResult;
}): string | null {
  const sourceConfigPath = findBuildSourceConfig(options);
  if (sourceConfigPath !== null) return sourceConfigPath;
  if (!isDtsConfigPath(options.configPath)) return null;
  return getSourceConfigPathForGeneratedDts({
    dtsConfigPath: options.configPath,
    generatedGraph: options.generatedGraph,
  });
}

function createCombinationRoot(options: {
  checker: ResolvedCheckerConfig;
  configPath: string;
  generatedGraph: GeneratedTsconfigGraphResult;
}): CheckerCombinationRoot[] {
  const entryConfigPath = getSourceConfigPathForBuildConfig({
    checkerName: options.checker.name,
    configPath: options.configPath,
    generatedGraph: options.generatedGraph,
  });
  if (entryConfigPath === null) return [];
  return [
    {
      checker: options.checker,
      configPath: options.configPath,
      entryConfigPath,
    },
  ];
}

export function collectCheckerBuildCombinationRoots(options: {
  checkers: readonly ResolvedCheckerConfig[];
  generatedGraph: GeneratedTsconfigGraphResult;
  projectRootDir: string;
}): CheckerCombinationRoot[] {
  return options.checkers.flatMap((checker) => {
    const checkerEntryPath = options.generatedGraph.checkerEntries.get(
      checker.name,
    );
    if (checkerEntryPath === undefined) return [];
    return getRawReferencePathsForConfig(
      options.projectRootDir,
      checkerEntryPath,
    ).flatMap((configPath) =>
      createCombinationRoot({
        checker,
        configPath,
        generatedGraph: options.generatedGraph,
      }),
    );
  });
}

function createRouteEntry(options: {
  generatedConfigPath: string;
  generatedGraph: GeneratedTsconfigGraphResult;
  root: CheckerCombinationRoot;
}): BuildCheckerCombinationEntry[] {
  const sourceConfigPath = getSourceConfigPathForGeneratedDts({
    dtsConfigPath: options.generatedConfigPath,
    generatedGraph: options.generatedGraph,
  });
  if (sourceConfigPath === null) return [];
  return [
    {
      checker: options.root.checker,
      entryConfigPath: options.root.entryConfigPath,
      generatedConfigPath: options.generatedConfigPath,
      sourceConfigPath,
    },
  ];
}

function collectRouteEntries(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  projectRootDir: string;
  root: CheckerCombinationRoot;
}): BuildCheckerCombinationEntry[] {
  const route = collectGraphProjectRouteFromRoot({
    rootConfigPath: options.root.configPath,
    rootDir: options.projectRootDir,
  });
  return route.projectPaths
    .filter(isDtsConfigPath)
    .flatMap((generatedConfigPath) =>
      createRouteEntry({
        generatedConfigPath,
        generatedGraph: options.generatedGraph,
        root: options.root,
      }),
    );
}

export function collectBuildGraphCombinationEntries(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  projectRootDir: string;
  roots: readonly CheckerCombinationRoot[];
}): BuildCheckerCombinationEntry[] {
  return options.roots.flatMap((root) =>
    collectRouteEntries({ ...options, root }),
  );
}
