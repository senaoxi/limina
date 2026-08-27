import {
  type CheckerProjectConfigCache,
  type CheckerProjectParseContext,
  isBuildCapablePreset,
  normalizeExtensions,
  parseCheckerProjectConfigForContext,
  resolveCheckerProjectExtensions,
} from '#checkers';
import {
  getActiveCheckers,
  type ResolvedCheckerConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import type {
  GeneratedTsconfigGraphResult,
  GovernedSourceUnit,
} from '#core/build-graph/runner';
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
    checkerPresets: uniqueValues(
      checkers.map((checker) => checker.name).filter(isBuildCapablePreset),
    ),
    extensions: normalizeExtensions(
      checkers.flatMap((checker) => checker.extensions),
    ),
  };
}

export function createCheckerProjectContext(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  extensions: string[];
  preset: ResolvedCheckerConfig['name'];
  virtualFiles?: ReadonlyMap<string, string>;
  vueSemanticIdentity?: CheckerProjectParseContext['vueSemanticIdentity'];
}): CheckerProjectParseContext {
  const adapterExtensions =
    options.vueSemanticIdentity?.extensions ??
    resolveCheckerProjectExtensions({
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
    vueSemanticIdentity: options.vueSemanticIdentity,
  };
}

export function parseProjectCoverageFileNames(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  context: CheckerProjectParseContext;
  projectConfigCache?: CheckerProjectConfigCache;
  virtualFiles: ReadonlyMap<string, string>;
}): string[] {
  return parseCheckerProjectConfigForContext({
    cache: options.projectConfigCache,
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
  projectConfigCache?: CheckerProjectConfigCache;
  virtualFiles: ReadonlyMap<string, string>;
}): { fileNames: string[]; ownerRootDir: string } {
  const parsed = parseCheckerProjectConfigForContext({
    cache: options.projectConfigCache,
    configPath: options.configPath,
    context: options.context,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.virtualFiles,
  });
  const coverageParsed = isDtsConfigPath(options.configPath)
    ? parseCheckerProjectConfigForContext({
        cache: options.projectConfigCache,
        configPath: getProofCompanionConfigPath(
          options.config,
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
  route: CheckerGraphProjectRoute,
): RouteProjectContext[] {
  return route.projectPaths.filter(isDtsConfigPath).map((projectPath) => ({
    context: {
      checkerPresets: [route.checkerPreset],
      extensions: normalizeExtensions(route.extensions),
    },
    projectPath,
  }));
}

function mergeProjectContext(
  existing: CheckerProjectParseContext | undefined,
  incoming: CheckerProjectParseContext,
): CheckerProjectParseContext {
  const current = getProjectContext(existing);
  const currentIdentity = current.vueSemanticIdentity;
  const incomingIdentity = incoming.vueSemanticIdentity;
  assertCompatibleVueIdentities(currentIdentity, incomingIdentity);

  return {
    checkerPresets: uniqueValues([
      ...current.checkerPresets,
      ...incoming.checkerPresets,
    ]),
    extensions: normalizeExtensions([
      ...current.extensions,
      ...incoming.extensions,
    ]),
    vueSemanticIdentity: currentIdentity || incomingIdentity,
  };
}

function getProjectContext(
  context: CheckerProjectParseContext | undefined,
): CheckerProjectParseContext {
  if (context !== undefined) return context;
  return { checkerPresets: [], extensions: [] };
}

function assertCompatibleVueIdentities(
  current: CheckerProjectParseContext['vueSemanticIdentity'],
  incoming: CheckerProjectParseContext['vueSemanticIdentity'],
): void {
  const currentId = getVueSemanticIdentityId(current);
  const incomingId = getVueSemanticIdentityId(incoming);
  const conflicts = [
    currentId !== undefined,
    incomingId !== undefined,
    currentId !== incomingId,
  ].every(Boolean);
  if (!conflicts) return;
  throw new Error(
    'Generated proof project received conflicting Vue semantic identities.',
  );
}

function getVueSemanticIdentityId(
  identity: CheckerProjectParseContext['vueSemanticIdentity'],
): string | undefined {
  if (identity === undefined) return undefined;
  return identity.id;
}

function getGovernedProjectionPaths(unit: GovernedSourceUnit): string[] {
  const projection = unit.buildProjection;
  return [
    'buildConfigPath' in projection ? projection.buildConfigPath : undefined,
    'dtsConfigPath' in projection ? projection.dtsConfigPath : undefined,
  ].filter((filePath): filePath is string => filePath !== undefined);
}

function createGovernedProjectContexts(
  generatedGraph: GeneratedTsconfigGraphResult | undefined,
): RouteProjectContext[] {
  if (generatedGraph === undefined) return [];
  return [...generatedGraph.governedSources.values()].flatMap(
    (governedSources) =>
      [...governedSources.values()].flatMap((unit) =>
        unit.context.vueSemanticIdentity === undefined
          ? []
          : getGovernedProjectionPaths(unit).map((projectPath) => ({
              context: {
                checkerPresets: [unit.primaryCheckerName],
                extensions: [],
                vueSemanticIdentity: unit.context.vueSemanticIdentity,
              },
              projectPath,
            })),
      ),
  );
}

export function collectProjectContextsByPath(
  routes: CheckerGraphProjectRoute[],
  generatedGraph?: GeneratedTsconfigGraphResult,
): Map<string, CheckerProjectParseContext> {
  const contexts = [
    ...routes.flatMap(createRouteProjectContexts),
    ...createGovernedProjectContexts(generatedGraph),
  ];
  const contextsByPath = new Map<string, CheckerProjectParseContext>();

  for (const entry of contexts) {
    contextsByPath.set(
      entry.projectPath,
      mergeProjectContext(contextsByPath.get(entry.projectPath), entry.context),
    );
  }

  return contextsByPath;
}
