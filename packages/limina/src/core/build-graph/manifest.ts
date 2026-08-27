import type { ResolvedCheckerConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toPosixPath, toRelativePath } from '#utils/path';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import { compareDependencyEdges } from './dependency-edge-order';
import type {
  GeneratedKnipPackageConfig,
  GeneratedKnipPackageDiagnostic,
} from './generated-knip';
import {
  createExecutionTargets,
  createOwnershipManifest,
} from './manifest-ownership';
import { generatedGraphManifestVersion } from './manifest-version';
import type {
  GeneratedBuildModule,
  GeneratedBuildModuleManifest,
  GeneratedDependencyEdge,
  GeneratedTsconfigGraphManifest,
  GovernedSourceUnit,
  SourceProject,
} from './types';

function toManifestPath(rootDir: string, filePath: string): string {
  return toPosixPath(toRelativePath(rootDir, filePath));
}

function createBuildModuleRecord(options: {
  modules: ReadonlyMap<string, GeneratedBuildModule>;
  rootDir: string;
}): Record<string, GeneratedBuildModuleManifest> {
  return Object.fromEntries(
    [...options.modules]
      .map(
        ([sourceConfigPath, module]) =>
          [
            toManifestPath(options.rootDir, sourceConfigPath),
            {
              kind: module.kind,
              path: toManifestPath(options.rootDir, module.path),
            },
          ] as const,
      )
      .sort(([left], [right]) => compareCodeUnits(left, right)),
  );
}

function createSourceDtsRecords(options: {
  projects: SourceProject[];
  rootDir: string;
}): {
  dtsToSource: Record<string, string>;
  sourceToDts: Record<string, string>;
} {
  const pairs = options.projects.map((project) => ({
    dtsPath: toManifestPath(options.rootDir, project.dtsConfigPath),
    sourcePath: toManifestPath(options.rootDir, project.configPath),
  }));
  return {
    dtsToSource: Object.fromEntries(
      [...pairs]
        .sort((left, right) => compareCodeUnits(left.dtsPath, right.dtsPath))
        .map(({ dtsPath, sourcePath }) => [dtsPath, sourcePath]),
    ),
    sourceToDts: Object.fromEntries(
      [...pairs]
        .sort((left, right) =>
          compareCodeUnits(left.sourcePath, right.sourcePath),
        )
        .map(({ dtsPath, sourcePath }) => [sourcePath, dtsPath]),
    ),
  };
}

function getModuleMap(options: {
  checkerName: string;
  modulesByChecker: ReadonlyMap<string, Map<string, GeneratedBuildModule>>;
}): Map<string, GeneratedBuildModule> {
  return options.modulesByChecker.get(options.checkerName) ?? new Map();
}

function getCheckerValues<T>(
  valuesByChecker: ReadonlyMap<string, T[]>,
  checkerName: string,
): T[] {
  return valuesByChecker.get(checkerName) ?? [];
}

function createCheckerManifest(options: {
  checker: ResolvedCheckerConfig;
  checkerEntries: ReadonlyMap<string, string>;
  configToOutputBuildByChecker: ReadonlyMap<
    string,
    Map<string, GeneratedBuildModule>
  >;
  governedSourcesByChecker: ReadonlyMap<string, GovernedSourceUnit[]>;
  projectsByChecker: ReadonlyMap<string, SourceProject[]>;
  rootDir: string;
  sourceToBuildByChecker: ReadonlyMap<
    string,
    Map<string, GeneratedBuildModule>
  >;
}): GeneratedTsconfigGraphManifest['checkers'][string] | null {
  const entryPath = options.checkerEntries.get(options.checker.name);
  if (!entryPath) {
    return null;
  }
  const projects = getCheckerValues(
    options.projectsByChecker,
    options.checker.name,
  );
  const sourceDtsRecords = createSourceDtsRecords({
    projects,
    rootDir: options.rootDir,
  });
  return {
    configToOutputBuild: createBuildModuleRecord({
      modules: getModuleMap({
        checkerName: options.checker.name,
        modulesByChecker: options.configToOutputBuildByChecker,
      }),
      rootDir: options.rootDir,
    }),
    entry: toManifestPath(options.rootDir, entryPath),
    name: options.checker.name,
    roots: getCheckerValues(
      options.governedSourcesByChecker,
      options.checker.name,
    )
      .map((unit) => toManifestPath(options.rootDir, unit.configPath))
      .sort(compareCodeUnits),
    sourceToBuild: createBuildModuleRecord({
      modules: getModuleMap({
        checkerName: options.checker.name,
        modulesByChecker: options.sourceToBuildByChecker,
      }),
      rootDir: options.rootDir,
    }),
    sourceToDts: sourceDtsRecords.sourceToDts,
    dtsToSource: sourceDtsRecords.dtsToSource,
  };
}

function createManifestCheckers(options: {
  checkerEntries: ReadonlyMap<string, string>;
  checkers: ResolvedCheckerConfig[];
  configToOutputBuildByChecker: ReadonlyMap<
    string,
    Map<string, GeneratedBuildModule>
  >;
  governedSourcesByChecker: ReadonlyMap<string, GovernedSourceUnit[]>;
  projectsByChecker: ReadonlyMap<string, SourceProject[]>;
  rootDir: string;
  sourceToBuildByChecker: ReadonlyMap<
    string,
    Map<string, GeneratedBuildModule>
  >;
}): GeneratedTsconfigGraphManifest['checkers'] {
  const manifestCheckers: GeneratedTsconfigGraphManifest['checkers'] = {};
  for (const checker of [...options.checkers].sort((left, right) =>
    compareCodeUnits(left.name, right.name),
  )) {
    const manifest = createCheckerManifest({ ...options, checker });
    if (manifest) {
      manifestCheckers[checker.name] = manifest;
    }
  }
  return manifestCheckers;
}

function createDependencyEdgeManifest(
  edge: GeneratedDependencyEdge,
  rootDir: string,
): GeneratedTsconfigGraphManifest['dependencyEdges'][number] {
  const base = {
    file: edge.file,
    fromChecker: edge.fromChecker,
    fromConfig: toManifestPath(rootDir, edge.fromConfigPath),
    importedSpecifier: edge.importedSpecifier,
    kind: edge.kind,
    resolvedFile: toManifestPath(rootDir, edge.resolvedFilePath),
    toChecker: edge.toChecker,
    toConfig: toManifestPath(rootDir, edge.toConfigPath),
  };
  return edge.kind === 'declaration-provider'
    ? { ...base, cacheReuse: edge.cacheReuse, kind: edge.kind }
    : { ...base, kind: edge.kind };
}

function optionalString(value: string | null | undefined): string {
  return value ?? '';
}

function firstNonZero(comparisons: readonly number[]): number {
  return comparisons.find((comparison) => comparison !== 0) ?? 0;
}

function compareKnipScripts(
  left: GeneratedKnipPackageConfig['scripts'][number],
  right: GeneratedKnipPackageConfig['scripts'][number],
): number {
  return firstNonZero([
    compareCodeUnits(left.name, right.name),
    compareCodeUnits(left.configPath, right.configPath),
    compareCodeUnits(left.command, right.command),
    compareCodeUnits(left.mode, right.mode),
    compareCodeUnits(
      optionalString(left.checker),
      optionalString(right.checker),
    ),
  ]);
}

function canonicalizeKnipPackageConfig(
  config: GeneratedKnipPackageConfig,
): GeneratedKnipPackageConfig {
  return {
    ...config,
    references: [...config.references].sort(compareCodeUnits),
    scripts: [...config.scripts].sort(compareKnipScripts),
  };
}

function compareKnipPackageConfigs(
  left: GeneratedKnipPackageConfig,
  right: GeneratedKnipPackageConfig,
): number {
  return firstNonZero([
    compareCodeUnits(left.packageJsonPath, right.packageJsonPath),
    compareCodeUnits(left.configPath, right.configPath),
    compareCodeUnits(left.packageDirectory, right.packageDirectory),
    compareCodeUnits(
      optionalString(left.packageName),
      optionalString(right.packageName),
    ),
  ]);
}

function compareKnipDiagnostics(
  left: GeneratedKnipPackageDiagnostic,
  right: GeneratedKnipPackageDiagnostic,
): number {
  return firstNonZero([
    compareCodeUnits(left.packageJsonPath, right.packageJsonPath),
    compareCodeUnits(
      optionalString(left.scriptName),
      optionalString(right.scriptName),
    ),
    compareCodeUnits(left.reason, right.reason),
    compareCodeUnits(
      optionalString(left.command),
      optionalString(right.command),
    ),
    compareCodeUnits(
      optionalString(left.packageName),
      optionalString(right.packageName),
    ),
  ]);
}

export function createManifest(options: {
  checkerEntries: Map<string, string>;
  checkers: ResolvedCheckerConfig[];
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  generatedKnipDiagnostics: GeneratedKnipPackageDiagnostic[];
  generatedKnipPackageConfigs: GeneratedKnipPackageConfig[];
  governedSourcesByChecker: Map<string, GovernedSourceUnit[]>;
  ownedArtifacts: string[];
  ownershipPlan?: CheckerOwnershipPlan;
  projectsByChecker: Map<string, SourceProject[]>;
  dependencyEdges: GeneratedDependencyEdge[];
  rootDir: string;
  sourceToBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
}): GeneratedTsconfigGraphManifest {
  const checkers = createManifestCheckers(options);
  return {
    version: generatedGraphManifestVersion,
    generatedBy: 'limina',
    checkers,
    knip: {
      diagnostics: [...options.generatedKnipDiagnostics].sort(
        compareKnipDiagnostics,
      ),
      packages: options.generatedKnipPackageConfigs
        .map(canonicalizeKnipPackageConfig)
        .sort(compareKnipPackageConfigs),
    },
    ownedArtifacts: [...options.ownedArtifacts].sort(compareCodeUnits),
    ownership: createOwnershipManifest(options),
    targets: createExecutionTargets({
      checkers,
      governedSourcesByChecker: options.governedSourcesByChecker,
      rootDir: options.rootDir,
    }),
    dependencyEdges: [...options.dependencyEdges]
      .sort(compareDependencyEdges)
      .map((edge) => createDependencyEdgeManifest(edge, options.rootDir)),
  };
}
