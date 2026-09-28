import type {
  BuildCheckerName,
  CheckerConfig,
  CheckerConfigMode,
  LiminaConfig,
  ResolvedCheckerConfig,
} from '#config/runner';
import { getNamedCheckerConfigs } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import {
  getTypeScriptCheckerExtensions,
  normalizeExtensions,
} from './extensions';
import { getCheckerAdapter } from './registry';
import type { CheckerAdapter } from './types';

function isVueCheckerName(name: string): boolean {
  return name === 'vue-tsc';
}

function getProjectRootDir(options: { projectRootDir?: string }): string {
  return options.projectRootDir === undefined ? '' : options.projectRootDir;
}

function requireCheckerAdapter(preset: string): CheckerAdapter {
  const adapter = getCheckerAdapter(preset);
  if (adapter !== null) return adapter;
  throw new Error(`Checker preset "${preset}" is not supported.`);
}

function getNonVueExtensions(options: {
  adapter: CheckerAdapter;
  projectRootDir: string;
}): string[] {
  return options.adapter.extensions({
    configPath: normalizeAbsolutePath(
      path.resolve(options.projectRootDir, 'tsconfig.json'),
    ),
    projectRootDir: options.projectRootDir,
  });
}

interface CheckerExtensionContext {
  adapter: CheckerAdapter;
  checker: CheckerConfig;
  projectRootDir: string;
}

type CheckerExtensionResolver = (context: CheckerExtensionContext) => string[];

function getVueExtensions(): string[] {
  const extensions = getTypeScriptCheckerExtensions();
  return normalizeExtensions([...extensions, '.vue']);
}

function resolveVueExtensions(): string[] {
  return getVueExtensions();
}

function resolveNonVueExtensions(context: CheckerExtensionContext): string[] {
  return getNonVueExtensions({
    adapter: context.adapter,
    projectRootDir: context.projectRootDir,
  });
}

function getExtensionResolver(name: string): CheckerExtensionResolver {
  return isVueCheckerName(name)
    ? resolveVueExtensions
    : resolveNonVueExtensions;
}

function createExtensionContext(
  name: BuildCheckerName,
  checker: CheckerConfig,
  options: { projectRootDir?: string },
): CheckerExtensionContext {
  return {
    adapter: requireCheckerAdapter(name),
    checker,
    projectRootDir: getProjectRootDir(options),
  };
}

function resolveCheckerExtensions(context: CheckerExtensionContext): string[] {
  const resolver = getExtensionResolver(context.adapter.name);
  return resolver(context);
}

export function getCheckerExtensions(
  name: BuildCheckerName,
  checker: CheckerConfig,
  options: { projectRootDir?: string } = {},
): string[] {
  const context = createExtensionContext(name, checker, options);
  return resolveCheckerExtensions(context);
}

function getConfiguredCheckerMode(
  config: LiminaConfig,
): CheckerConfigMode | undefined {
  const shared = config.config;
  return shared === undefined ? undefined : shared.checkers;
}

function getExplicitCheckerMap(
  config: LiminaConfig,
): Partial<Record<string, CheckerConfig>> | undefined {
  const checkers = getConfiguredCheckerMode(config);
  if (checkers === undefined) return undefined;
  const named = getNamedCheckerConfigs(checkers);
  return Object.keys(named).length === 0 ? undefined : named;
}

function trimPatterns(patterns: readonly string[] | undefined): string[] {
  if (patterns === undefined) return [];
  return patterns.map((value) => value.trim());
}

function createResolvedChecker(options: {
  checker: CheckerConfig;
  name: ResolvedCheckerConfig['name'];
  projectRootDir: string | undefined;
}): ResolvedCheckerConfig {
  return {
    exclude: trimPatterns(options.checker.exclude),
    extensions:
      options.name === 'svelte-check' || options.name === 'astro'
        ? []
        : getCheckerExtensions(options.name, options.checker, {
            projectRootDir: options.projectRootDir,
          }),
    include: trimPatterns(options.checker.include),
    name: options.name,
  };
}

function getResolvedProjectRoot(config: LiminaConfig): string | undefined {
  if (!('rootDir' in config)) return undefined;
  return String(config.rootDir);
}

export function getResolvedCheckers(
  config: LiminaConfig,
): ResolvedCheckerConfig[] {
  const checkerMap = getExplicitCheckerMap(config);
  if (checkerMap === undefined) return [];
  const projectRootDir = getResolvedProjectRoot(config);
  return Object.entries(checkerMap)
    .filter(
      (entry): entry is [ResolvedCheckerConfig['name'], CheckerConfig] =>
        entry[1] !== undefined,
    )
    .map(([name, checker]) =>
      createResolvedChecker({ checker, name, projectRootDir }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}
