import {
  type CheckerProjectConfigCache,
  type CheckerProjectParseContext,
  getBuildCheckerSupportedExtensions,
  parseCheckerProjectConfigForContext,
} from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import {
  capabilityDiscoveryExtensions,
  getFileExtension,
} from './generated/file-extensions';
import { createGeneratedGraphStructuredError } from './problems';
import {
  collectAutoSourceConfigModules,
  createEmptySourceConfigCollection,
} from './source-config-collection';
import type { AutoCheckerPreset, AutoScope, AutoScopeProject } from './types';

function createAutoScopeProject(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): AutoScopeProject {
  const context: CheckerProjectParseContext = {
    checkerPresets: ['tsc'],
    extensions: capabilityDiscoveryExtensions,
  };
  const parsed = parseCheckerProjectConfigForContext({
    cache: options.projectConfigCache,
    configPath: options.configPath,
    context,
    projectRootDir: options.config.rootDir,
  });
  return {
    configPath: options.configPath,
    context,
    fileNames: parsed.fileNames.map(normalizeAbsolutePath).sort(),
    options: parsed.options,
  };
}

function setAutoRootConfigPaths(scope: AutoScope): void {
  scope.collection.rootConfigPaths =
    scope.collection.buildModulesBySourcePath.has(scope.entryConfigPath)
      ? [scope.entryConfigPath]
      : [];
}

function createAutoScope(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  entryConfigPath: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): AutoScope {
  const collection = createEmptySourceConfigCollection([
    options.entryConfigPath,
  ]);
  const problems: string[] = [];
  collectAutoSourceConfigModules({
    activatedRegions: options.activatedRegions,
    collection,
    config: options.config,
    entryConfigPath: options.entryConfigPath,
    problems,
    projectConfigCache: options.projectConfigCache,
  });
  if (problems.length > 0) {
    throw createGeneratedGraphStructuredError({
      config: options.config,
      fallback: 'Failed to collect auto checker scope.',
      problems,
    });
  }

  const scope: AutoScope = {
    collection,
    entryConfigPath: options.entryConfigPath,
    projects: [...collection.projectConfigPaths]
      .sort(compareCodeUnits)
      .map((configPath) =>
        createAutoScopeProject({
          config: options.config,
          configPath,
          projectConfigCache: options.projectConfigCache,
        }),
      ),
  };
  setAutoRootConfigPaths(scope);
  return scope;
}

export function collectAutoScope(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  entryConfigPath: string;
  projectConfigCache?: CheckerProjectConfigCache;
}): AutoScope | null {
  const scope = createAutoScope(options);
  return scope.collection.projectConfigPaths.size > 0 ? scope : null;
}

function createUnsupportedExtensionProblem(options: {
  config: ResolvedLiminaConfig;
  entryConfigPath: string;
  extension: string;
  fileName: string;
}): string {
  return [
    'Unsupported auto checker source file extension:',
    `  scope: ${toRelativePath(options.config.rootDir, options.entryConfigPath)}`,
    `  extension: ${options.extension}`,
    `  example: ${toRelativePath(options.config.rootDir, options.fileName)}`,
    '  reason: auto checker mode can only route TypeScript, JavaScript, JSON, and Vue source scopes.',
    '  fix: move this file to an explicit checker scope or configure config.checkers manually.',
  ].join('\n');
}

function classifyAutoFile(options: {
  config: ResolvedLiminaConfig;
  entryConfigPath: string;
  fileName: string;
  typescriptExtensions: ReadonlySet<string>;
  vueExtensions: ReadonlySet<string>;
}): boolean {
  const extension = getFileExtension(options.fileName);
  if (!extension) {
    return false;
  }
  if (!options.vueExtensions.has(extension)) {
    throw new Error(
      createUnsupportedExtensionProblem({
        config: options.config,
        entryConfigPath: options.entryConfigPath,
        extension,
        fileName: options.fileName,
      }),
    );
  }
  return !options.typescriptExtensions.has(extension);
}

function projectNeedsVue(options: {
  config: ResolvedLiminaConfig;
  entryConfigPath: string;
  project: AutoScopeProject;
  typescriptExtensions: ReadonlySet<string>;
  vueExtensions: ReadonlySet<string>;
}): boolean {
  return options.project.fileNames.some((fileName) =>
    classifyAutoFile({ ...options, fileName }),
  );
}

export function classifyAutoScope(options: {
  config: ResolvedLiminaConfig;
  scope: AutoScope;
}): AutoCheckerPreset {
  const typescriptExtensions = new Set(
    getBuildCheckerSupportedExtensions('tsc'),
  );
  const vueExtensions = new Set(getBuildCheckerSupportedExtensions('vue-tsc'));
  const needsVue = options.scope.projects.some((project) =>
    projectNeedsVue({
      config: options.config,
      entryConfigPath: options.scope.entryConfigPath,
      project,
      typescriptExtensions,
      vueExtensions,
    }),
  );
  return needsVue ? 'vue-tsc' : 'tsc';
}
