import type { CheckerProjectConfigCache } from '#checkers';
import type { CheckerName, ResolvedLiminaInputs } from '#config/runner';
import type { JsonObject } from '#core/tsconfig/actions';
import { compareCodeUnits } from '#utils/collections';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import {
  createAutoScopeProject,
  createExplicitScopeProject,
} from './auto-checker-project';
import type { AutoCheckerPreset } from './auto-checker-types';
import { inspectFrameworkIntent } from './framework-intent';
import { capabilityDiscoveryExtensions } from './generated/file-extensions';
import { createGeneratedGraphStructuredError } from './problems';
import {
  createAutoFrameworkEvidence,
  type FrameworkIntentHint,
} from './source-capabilities';
import {
  collectCheckerSourceConfigModules,
  collectCheckerSourceConfigs,
  createEmptySourceConfigCollection,
} from './source-config-collection';
import type { SourceConfigDiscovery } from './source-config-discovery';
import type { AutoScope, CheckerSourceConfigCollection } from './types';

interface CollectAutoSourceConfigModulesOptions {
  activatedRegions: WorkspaceRegionPathIndex;
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaInputs;
  discoveryExtensions: string[];
  entryConfigPath: string;
  problems: string[];
  projectConfigCache?: CheckerProjectConfigCache;
  sourceConfigInspector: (options: {
    configObject: JsonObject;
    sourceConfigPath: string;
  }) => void;
}

function setAutoRootConfigPaths(scope: AutoScope): void {
  scope.collection.rootConfigPaths =
    scope.collection.buildModulesBySourcePath.has(scope.entryConfigPath)
      ? [scope.entryConfigPath]
      : [];
}

function collectAutoSourceConfigModules(
  options: CollectAutoSourceConfigModulesOptions,
): void {
  collectCheckerSourceConfigModules({
    activatedRegions: options.activatedRegions,
    checkerName: 'tsc',
    checkerPreset: 'tsc',
    collection: options.collection,
    config: options.config,
    discoveryExtensions: options.discoveryExtensions,
    problems: options.problems,
    projectConfigCache: options.projectConfigCache,
    seenConfigs: new Set(),
    sourceConfigPath: options.entryConfigPath,
    sourceConfigInspector: options.sourceConfigInspector,
  });
}

function createAutoScope(options: {
  onProblems?: (problems: string[]) => void;
  sourceDiscovery?: SourceConfigDiscovery;
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaInputs;
  entryConfigPath: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): AutoScope {
  const collection = createEmptySourceConfigCollection([
    options.entryConfigPath,
  ]);
  collection.sourceDiscovery = options.sourceDiscovery;
  const problems: string[] = [];
  const intentHintsByConfigPath = new Map<string, FrameworkIntentHint[]>();
  collectAutoSourceConfigModules({
    activatedRegions: options.activatedRegions,
    collection,
    config: options.config,
    discoveryExtensions: capabilityDiscoveryExtensions,
    entryConfigPath: options.entryConfigPath,
    problems,
    projectConfigCache: options.projectConfigCache,
    sourceConfigInspector: ({ configObject, sourceConfigPath }) => {
      const inspection = inspectFrameworkIntent({
        config: options.config,
        configObject,
        configPath: sourceConfigPath,
      });
      intentHintsByConfigPath.set(sourceConfigPath, inspection.intentHints);
      problems.push(...inspection.problems);
    },
  });
  if (options.onProblems) options.onProblems(problems);
  else if (problems.length > 0) {
    throw createGeneratedGraphStructuredError({
      config: options.config,
      fallback: 'Failed to collect auto checker scope.',
      problems,
    });
  }

  const projects = [...collection.projectConfigPaths]
    .sort(compareCodeUnits)
    .map((configPath) => {
      const packageRootDirectory =
        collection.packageRootBySourcePath.get(configPath);
      if (packageRootDirectory === undefined) {
        throw new Error(`Missing auto checker package root for ${configPath}.`);
      }
      return createAutoScopeProject({
        activatedRegions: options.activatedRegions,
        config: options.config,
        configPath,
        intentHints: intentHintsByConfigPath.get(configPath) ?? [],
        packageRootDir: packageRootDirectory,
        projectConfigCache: options.projectConfigCache,
      });
    });
  const projectByConfigPath = new Map(
    projects.map((project) => [project.configPath, project]),
  );
  const scope: AutoScope = {
    collection,
    entryConfigPath: options.entryConfigPath,
    frameworkEvidence: [...intentHintsByConfigPath]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([configPath, intentHints]) =>
        createAutoFrameworkEvidence({
          configPath,
          filePartition: projectByConfigPath.get(configPath)?.filePartition,
          intentHints,
        }),
      ),
    projects,
  };
  setAutoRootConfigPaths(scope);
  return scope;
}

export function collectAutoScope(options: {
  onProblems?: (problems: string[]) => void;
  sourceDiscovery?: SourceConfigDiscovery;
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaInputs;
  entryConfigPath: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): AutoScope | null {
  const scope = createAutoScope(options);
  return scope.collection.projectConfigPaths.size > 0 ? scope : null;
}

function getExplicitParsing(checkerName: CheckerName): {
  checkerPreset: CheckerName;
  discoveryExtensions: string[];
} {
  if (checkerName === 'astro') {
    return { checkerPreset: 'tsc', discoveryExtensions: ['.astro'] };
  }
  return checkerName === 'svelte-check'
    ? { checkerPreset: 'tsc', discoveryExtensions: ['.svelte'] }
    : { checkerPreset: checkerName, discoveryExtensions: [] };
}

export function collectExplicitScope(options: {
  onProblems?: (problems: string[]) => void;
  sourceDiscovery?: SourceConfigDiscovery;
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: CheckerName;
  config: ResolvedLiminaInputs;
  entryConfigPath: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): AutoScope | null {
  const parsing = getExplicitParsing(options.checkerName);
  const collection = collectCheckerSourceConfigs({
    onProblems: options.onProblems,
    sourceDiscovery: options.sourceDiscovery,
    activatedRegions: options.activatedRegions,
    checkerName: options.checkerName,
    checkerPreset: parsing.checkerPreset,
    config: options.config,
    discoveryExtensions: parsing.discoveryExtensions,
    entryConfigPaths: [options.entryConfigPath],
    projectConfigCache: options.projectConfigCache,
  });
  const projects = [...collection.projectConfigPaths]
    .sort(compareCodeUnits)
    .map((configPath) =>
      createExplicitScopeProject({
        ...options,
        configPath,
        packageRootDir: collection.packageRootBySourcePath.get(configPath)!,
      }),
    );
  if (collection.projectConfigPaths.size === 0) {
    return null;
  }
  return {
    authoritativeChecker: options.checkerName,
    collection,
    entryConfigPath: options.entryConfigPath,
    frameworkEvidence: [],
    projects,
  };
}

export function classifyAutoScope(scope: AutoScope): AutoCheckerPreset {
  const isNeedsVue = scope.projects.some(
    (project) => project.filePartition.vueFiles.length > 0,
  );
  return isNeedsVue ? 'vue-tsc' : 'tsc';
}
