import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { CheckerGraphProjectRoute } from '#core/tsconfig/actions';
import { isDtsConfigPath } from '#core/tsconfig/actions';
import { isPathInsideDirectory, toRelativePath } from '#utils/path';
import {
  createCheckerProjectContext,
  parseProjectCoverage,
  parseProjectCoverageFileNames,
} from './checker-context';
import { addCoverage, type CoverageSource } from './coverage';
import type { CheckerCoverageTarget } from './runner-types';

interface CoverageEntry {
  filePath: string;
  source: CoverageSource;
}

interface CoverageDestination {
  coverageByFile: Map<string, CoverageSource[]>;
  outsideSourceCoverageByFile?: Map<string, CoverageSource[]>;
  sourceFiles: Set<string>;
}

function recordCoverage(
  destination: CoverageDestination,
  entry: CoverageEntry,
): void {
  if (destination.sourceFiles.has(entry.filePath)) {
    addCoverage(destination.coverageByFile, entry.filePath, entry.source);
    return;
  }

  if (destination.outsideSourceCoverageByFile) {
    addCoverage(
      destination.outsideSourceCoverageByFile,
      entry.filePath,
      entry.source,
    );
  }
}

function createGraphProjectCoverageEntries(options: {
  config: ResolvedLiminaConfig;
  graphProjectPath: string;
  projectConfigCache?: CheckerProjectConfigCache;
  route: CheckerGraphProjectRoute;
  virtualFiles: ReadonlyMap<string, string>;
}): CoverageEntry[] {
  const projectContext = createCheckerProjectContext({
    config: options.config,
    configPath: options.graphProjectPath,
    extensions: options.route.extensions,
    preset: options.route.checkerPreset,
    virtualFiles: options.virtualFiles,
  });
  const projectCoverage = parseProjectCoverage({
    config: options.config,
    configPath: options.graphProjectPath,
    context: projectContext,
    projectConfigCache: options.projectConfigCache,
    virtualFiles: options.virtualFiles,
  });
  const source: CoverageSource = {
    checkerEntryPath: options.route.rootConfigPath,
    checkerName: options.route.checkerName,
    checkerPreset: options.route.checkerPreset,
    label: toRelativePath(options.config.rootDir, options.graphProjectPath),
    projectPath: options.graphProjectPath,
    type: 'graph',
  };

  return projectCoverage.fileNames
    .filter((filePath) =>
      isPathInsideDirectory(filePath, projectCoverage.ownerRootDir),
    )
    .map((filePath) => ({ filePath, source }));
}

function createGraphCoverageEntries(options: {
  config: ResolvedLiminaConfig;
  graphRoutes: CheckerGraphProjectRoute[];
  projectConfigCache?: CheckerProjectConfigCache;
  virtualFiles: ReadonlyMap<string, string>;
}): CoverageEntry[] {
  return options.graphRoutes.flatMap((route) =>
    route.projectPaths.filter(isDtsConfigPath).flatMap((graphProjectPath) =>
      createGraphProjectCoverageEntries({
        config: options.config,
        graphProjectPath,
        route,
        virtualFiles: options.virtualFiles,
      }),
    ),
  );
}

function createGovernedCoverageEntries(options: {
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
}): CoverageEntry[] {
  return [...options.generatedGraph.governedSources.entries()].flatMap(
    ([checkerName, governedSources]) =>
      [...governedSources.values()].flatMap((unit) => {
        const source: CoverageSource = {
          checkerEntryPath:
            options.generatedGraph.checkerEntries.get(checkerName) ??
            unit.configPath,
          checkerName,
          checkerPreset: unit.primaryCheckerName,
          label: toRelativePath(options.config.rootDir, unit.configPath),
          projectPath: unit.configPath,
          type: 'graph',
        };
        return unit.ownedFileNames
          .filter((filePath) =>
            isPathInsideDirectory(filePath, unit.packageRootDir),
          )
          .map((filePath) => ({ filePath, source }));
      }),
  );
}

function hasGovernedSources(
  generatedGraph: GeneratedTsconfigGraphResult | undefined,
): generatedGraph is GeneratedTsconfigGraphResult {
  return (
    generatedGraph !== undefined &&
    generatedGraph.governedSources instanceof Map &&
    [...generatedGraph.governedSources.values()].some(
      (governedSources) => governedSources.size > 0,
    )
  );
}

function createCheckerProjectCoverageEntries(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  target: CheckerCoverageTarget;
  projectConfigCache?: CheckerProjectConfigCache;
  virtualFiles: ReadonlyMap<string, string>;
}): CoverageEntry[] {
  const projectContext = createCheckerProjectContext({
    config: options.config,
    configPath: options.configPath,
    extensions: options.target.checker.extensions,
    preset: options.target.checker.name,
    virtualFiles: options.virtualFiles,
  });
  const source: CoverageSource = {
    checkerEntryPath: options.target.configPath,
    checkerName: options.target.checker.name,
    label: `${toRelativePath(options.config.rootDir, options.configPath)} via ${options.target.label}`,
    projectPath: options.configPath,
    type: 'checker',
  };

  return parseProjectCoverageFileNames({
    config: options.config,
    configPath: options.configPath,
    context: projectContext,
    projectConfigCache: options.projectConfigCache,
    virtualFiles: options.virtualFiles,
  }).map((filePath) => ({ filePath, source }));
}

function createCheckerCoverageEntries(options: {
  checkerTargets: CheckerCoverageTarget[];
  config: ResolvedLiminaConfig;
  projectConfigCache?: CheckerProjectConfigCache;
  virtualFiles: ReadonlyMap<string, string>;
}): CoverageEntry[] {
  return options.checkerTargets.flatMap((target) =>
    target.coverageConfigPaths.filter(isDtsConfigPath).flatMap((configPath) =>
      createCheckerProjectCoverageEntries({
        config: options.config,
        configPath,
        target,
        virtualFiles: options.virtualFiles,
      }),
    ),
  );
}

export function collectCoverage(options: {
  config: ResolvedLiminaConfig;
  graphRoutes: CheckerGraphProjectRoute[];
  generatedGraph?: GeneratedTsconfigGraphResult;
  checkerTargets: CheckerCoverageTarget[];
  outsideSourceCoverageByFile?: Map<string, CoverageSource[]>;
  projectConfigCache?: CheckerProjectConfigCache;
  sourceFiles: Set<string>;
  virtualFiles: ReadonlyMap<string, string>;
}): Map<string, CoverageSource[]> {
  const coverageByFile = new Map<string, CoverageSource[]>();
  const destination: CoverageDestination = {
    coverageByFile,
    outsideSourceCoverageByFile: options.outsideSourceCoverageByFile,
    sourceFiles: options.sourceFiles,
  };
  const entries = [
    ...(hasGovernedSources(options.generatedGraph)
      ? createGovernedCoverageEntries({
          config: options.config,
          generatedGraph: options.generatedGraph,
        })
      : createGraphCoverageEntries(options)),
    ...createCheckerCoverageEntries(options),
  ];

  for (const entry of entries) {
    recordCoverage(destination, entry);
  }

  return coverageByFile;
}
