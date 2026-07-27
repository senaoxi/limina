import type {
  CheckerConfig,
  CheckerConfigMode,
  LiminaConfig,
  ResolvedCheckerConfig,
} from '#config/runner';
import { isAutoCheckerConfigMode } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import {
  getTypeScriptCheckerExtensions,
  normalizeExtensions,
} from './extensions';
import { getCheckerAdapter } from './registry';
import type { CheckerAdapter } from './types';

function isVueCheckerPreset(preset: string): boolean {
  if (preset === 'vue-tsc') return true;
  return preset === 'vue-tsgo';
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

function getExtensionResolver(preset: string): CheckerExtensionResolver {
  return isVueCheckerPreset(preset)
    ? resolveVueExtensions
    : resolveNonVueExtensions;
}

function createExtensionContext(
  checker: CheckerConfig,
  options: { projectRootDir?: string },
): CheckerExtensionContext {
  return {
    adapter: requireCheckerAdapter(checker.preset),
    checker,
    projectRootDir: getProjectRootDir(options),
  };
}

function resolveCheckerExtensions(context: CheckerExtensionContext): string[] {
  const resolver = getExtensionResolver(context.checker.preset);
  return resolver(context);
}

export function getCheckerExtensions(
  checker: CheckerConfig,
  options: { projectRootDir?: string } = {},
): string[] {
  const context = createExtensionContext(checker, options);
  return resolveCheckerExtensions(context);
}

function getConfiguredCheckerMode(
  config: LiminaConfig,
): CheckerConfigMode | undefined {
  const shared = config.config;
  return shared === undefined ? undefined : shared.checkers;
}

function getExplicitCheckerMapFromMode(
  checkers: CheckerConfigMode,
): Record<string, CheckerConfig> | undefined {
  if (isAutoCheckerConfigMode(checkers)) return undefined;
  return checkers;
}

function getExplicitCheckerMap(
  config: LiminaConfig,
): Record<string, CheckerConfig> | undefined {
  const checkers = getConfiguredCheckerMode(config);
  if (checkers === undefined) return undefined;
  return getExplicitCheckerMapFromMode(checkers);
}

function trimPatterns(patterns: readonly string[] | undefined): string[] {
  if (patterns === undefined) return [];
  return patterns.map((value) => value.trim());
}

function createResolvedChecker(options: {
  checker: CheckerConfig;
  name: string;
  projectRootDir: string | undefined;
}): ResolvedCheckerConfig {
  return {
    exclude: trimPatterns(options.checker.exclude),
    extensions: getCheckerExtensions(options.checker, {
      projectRootDir: options.projectRootDir,
    }),
    include: trimPatterns(options.checker.include),
    name: options.name,
    preset: options.checker.preset,
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
    .map(([name, checker]) =>
      createResolvedChecker({ checker, name, projectRootDir }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}
