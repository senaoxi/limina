import {
  type CheckerProjectParseContext,
  normalizeExtensions,
  parseCheckerProjectConfigForContext,
  resolveCheckerProjectExtensions,
} from '#checkers';
import {
  getActiveCheckers,
  type ResolvedCheckerConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  type CheckerGraphProjectRoute,
  isDtsConfigPath,
} from '#core/tsconfig/actions';
import { uniqueValues } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import { getProofCompanionConfigPath } from './config-reader';

function resolveActiveCheckers(
  config: ResolvedLiminaConfig,
  generatedGraph?: GeneratedTsconfigGraphResult,
): ResolvedCheckerConfig[] {
  if (generatedGraph) {
    return generatedGraph.checkers;
  }

  return getActiveCheckers(config);
}

export function getActiveCheckerContext(
  config: ResolvedLiminaConfig,
  generatedGraph?: GeneratedTsconfigGraphResult,
): CheckerProjectParseContext {
  const checkers = resolveActiveCheckers(config, generatedGraph);

  return {
    checkerPresets: uniqueValues(checkers.map((checker) => checker.preset)),
    extensions: normalizeExtensions(
      checkers.flatMap((checker) => checker.extensions),
    ),
  };
}

export function createCheckerProjectContext(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  extensions: string[];
  preset: ResolvedCheckerConfig['preset'];
  virtualFiles?: ReadonlyMap<string, string>;
}): CheckerProjectParseContext {
  const adapterExtensions = resolveCheckerProjectExtensions({
    configPath: options.configPath,
    preset: options.preset,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.virtualFiles,
  });

  return {
    checkerPresets: [options.preset],
    extensions: normalizeExtensions([
      ...options.extensions,
      ...adapterExtensions,
    ]),
  };
}

export function parseProjectCoverageFileNames(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  context: CheckerProjectParseContext;
  virtualFiles: ReadonlyMap<string, string>;
}): string[] {
  return parseCheckerProjectConfigForContext({
    configPath: options.configPath,
    context: options.context,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.virtualFiles,
  }).fileNames;
}

export function parseProjectCoverage(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  context: CheckerProjectParseContext;
  virtualFiles: ReadonlyMap<string, string>;
}): { fileNames: string[]; ownerRootDir: string } {
  const parsed = parseCheckerProjectConfigForContext({
    configPath: options.configPath,
    context: options.context,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.virtualFiles,
  });
  const coverageParsed = isDtsConfigPath(options.configPath)
    ? parseCheckerProjectConfigForContext({
        configPath: getProofCompanionConfigPath(
          options.configPath,
          options.virtualFiles,
        ),
        context: options.context,
        projectRootDir: options.config.rootDir,
      })
    : parsed;
  const ownerRootDir = parsed.options.rootDir
    ? normalizeAbsolutePath(parsed.options.rootDir)
    : path.dirname(options.configPath);

  return { fileNames: coverageParsed.fileNames, ownerRootDir };
}

interface RouteProjectContext {
  context: CheckerProjectParseContext;
  projectPath: string;
}

function createRouteProjectContexts(
  config: ResolvedLiminaConfig,
  route: CheckerGraphProjectRoute,
): RouteProjectContext[] {
  return route.projectPaths.filter(isDtsConfigPath).map((projectPath) => ({
    context: createCheckerProjectContext({
      config,
      configPath: projectPath,
      extensions: route.extensions,
      preset: route.checkerPreset,
    }),
    projectPath,
  }));
}

function mergeProjectContext(
  existing: CheckerProjectParseContext | undefined,
  incoming: CheckerProjectParseContext,
): CheckerProjectParseContext {
  const current = existing ?? { checkerPresets: [], extensions: [] };

  return {
    checkerPresets: uniqueValues([
      ...current.checkerPresets,
      ...incoming.checkerPresets,
    ]),
    extensions: normalizeExtensions([
      ...current.extensions,
      ...incoming.extensions,
    ]),
  };
}

export function collectProjectContextsByPath(
  config: ResolvedLiminaConfig,
  routes: CheckerGraphProjectRoute[],
): Map<string, CheckerProjectParseContext> {
  const contexts = routes.flatMap((route) =>
    createRouteProjectContexts(config, route),
  );
  const contextsByPath = new Map<string, CheckerProjectParseContext>();

  for (const entry of contexts) {
    contextsByPath.set(
      entry.projectPath,
      mergeProjectContext(contextsByPath.get(entry.projectPath), entry.context),
    );
  }

  return contextsByPath;
}
