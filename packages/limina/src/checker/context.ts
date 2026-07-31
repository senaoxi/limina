import type { CheckerPreset } from '#config/runner';
import { compareCodeUnits, uniqueValues } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { normalizeExtensions } from './extensions';
import { cloneParsedCheckerProjectConfig } from './project-base';
import { getCheckerAdapter } from './registry';
import type {
  CheckerProjectParseContext,
  ParsedCheckerProjectConfig,
} from './types';

export class CheckerProjectConfigCache {
  readonly #entries = new Map<string, ParsedCheckerProjectConfig>();

  get(cacheKey: string): ParsedCheckerProjectConfig | undefined {
    const cached = this.#entries.get(cacheKey);
    return cached === undefined
      ? undefined
      : cloneParsedCheckerProjectConfig(cached);
  }

  set(
    cacheKey: string,
    config: ParsedCheckerProjectConfig,
  ): ParsedCheckerProjectConfig {
    this.#entries.set(cacheKey, cloneParsedCheckerProjectConfig(config));
    return cloneParsedCheckerProjectConfig(config);
  }
}

function uniqueSortedPresets(
  presets: readonly CheckerPreset[],
): CheckerPreset[] {
  return uniqueValues([...presets]).sort(compareCodeUnits);
}

function resolveContextCheckerPresets(
  context: CheckerProjectParseContext,
): CheckerPreset[] {
  if (context.checkerPresets.length > 0) {
    return uniqueSortedPresets(context.checkerPresets);
  }
  return ['tsc'];
}

function getVirtualConfigContent(options: {
  configPath: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): string | undefined {
  if (options.virtualFiles === undefined) return undefined;
  return options.virtualFiles.get(normalizeAbsolutePath(options.configPath));
}

function createVirtualFilesIdentity(
  virtualFiles: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (virtualFiles === undefined) return undefined;
  const hash = createHash('sha256');
  for (const [filePath, content] of [...virtualFiles.entries()].sort(
    ([left], [right]) => compareCodeUnits(left, right),
  )) {
    hash.update(normalizeAbsolutePath(filePath));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function getConfigIdentity(options: {
  configPath: string;
  virtualContent: string | undefined;
}): { size: number; time: number | string } {
  if (options.virtualContent !== undefined) {
    return {
      size: options.virtualContent.length,
      time: options.virtualContent,
    };
  }
  const stats = statSync(options.configPath);
  return { size: stats.size, time: stats.mtimeMs };
}

function createParsedProjectConfigCacheKey(options: {
  allowNoInputDiagnostics?: boolean;
  checkerPresets: CheckerPreset[];
  configPath: string;
  extensions: string[];
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): string {
  const virtualContent = getVirtualConfigContent(options);
  const identity = getConfigIdentity({
    configPath: options.configPath,
    virtualContent,
  });
  return JSON.stringify({
    allowNoInputDiagnostics: options.allowNoInputDiagnostics,
    checkerPresets: options.checkerPresets,
    configPath: normalizeAbsolutePath(options.configPath),
    configSize: identity.size,
    configTime: identity.time,
    extensions: normalizeExtensions(options.extensions),
    projectRootDir: normalizeAbsolutePath(options.projectRootDir),
    virtualFilesIdentity: createVirtualFilesIdentity(options.virtualFiles),
  });
}

function requireFirstParsedConfig(
  configs: readonly ParsedCheckerProjectConfig[],
): ParsedCheckerProjectConfig {
  const firstConfig = configs[0];
  if (firstConfig !== undefined) return firstConfig;
  throw new Error('Unable to parse checker project config: no parser ran.');
}

function mergeParsedProjectConfigs(options: {
  extensions: string[];
  parsedConfigs: ParsedCheckerProjectConfig[];
}): ParsedCheckerProjectConfig {
  const firstConfig = requireFirstParsedConfig(options.parsedConfigs);
  return {
    extensions: normalizeExtensions([
      ...options.extensions,
      ...options.parsedConfigs.flatMap((config) => config.extensions),
    ]),
    fileNames: uniqueValues(
      options.parsedConfigs.flatMap((config) => config.fileNames),
    ).sort(compareCodeUnits),
    options: firstConfig.options,
  };
}

function parseWithPreset(options: {
  allowNoInputDiagnostics?: boolean;
  configPath: string;
  extensions: string[];
  preset: CheckerPreset;
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): ParsedCheckerProjectConfig {
  const adapter = getCheckerAdapter(options.preset);
  if (adapter === null) {
    throw new Error(`Checker preset "${options.preset}" is not supported.`);
  }
  return adapter.parseProjectConfig({
    allowNoInputDiagnostics: options.allowNoInputDiagnostics,
    configPath: options.configPath,
    extensions: options.extensions,
    projectRootDir: options.projectRootDir,
    virtualFiles: options.virtualFiles,
  });
}

function parseContextConfigs(options: {
  allowNoInputDiagnostics?: boolean;
  checkerPresets: CheckerPreset[];
  configPath: string;
  context: CheckerProjectParseContext;
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): ParsedCheckerProjectConfig[] {
  return options.checkerPresets.map((preset) =>
    parseWithPreset({
      allowNoInputDiagnostics: options.allowNoInputDiagnostics,
      configPath: options.configPath,
      extensions: options.context.extensions,
      preset,
      projectRootDir: options.projectRootDir,
      virtualFiles: options.virtualFiles,
    }),
  );
}

function getCachedConfig(
  cache: CheckerProjectConfigCache,
  cacheKey: string,
): ParsedCheckerProjectConfig | undefined {
  return cache.get(cacheKey);
}

function cacheParsedConfig(
  cache: CheckerProjectConfigCache,
  cacheKey: string,
  config: ParsedCheckerProjectConfig,
): ParsedCheckerProjectConfig {
  return cache.set(cacheKey, config);
}

function createParsedProjectConfig(options: {
  allowNoInputDiagnostics?: boolean;
  checkerPresets: CheckerPreset[];
  configPath: string;
  context: CheckerProjectParseContext;
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): ParsedCheckerProjectConfig {
  const parsedConfigs = parseContextConfigs(options);
  return mergeParsedProjectConfigs({
    extensions: options.context.extensions,
    parsedConfigs,
  });
}

function resolveCacheMiss(options: {
  allowNoInputDiagnostics?: boolean;
  cache: CheckerProjectConfigCache;
  cacheKey: string;
  checkerPresets: CheckerPreset[];
  configPath: string;
  context: CheckerProjectParseContext;
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): ParsedCheckerProjectConfig {
  const parsedConfig = createParsedProjectConfig(options);
  return cacheParsedConfig(options.cache, options.cacheKey, parsedConfig);
}

function resolveCachedProjectConfig(options: {
  allowNoInputDiagnostics?: boolean;
  cache: CheckerProjectConfigCache;
  cached: ParsedCheckerProjectConfig | undefined;
  cacheKey: string;
  checkerPresets: CheckerPreset[];
  configPath: string;
  context: CheckerProjectParseContext;
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): ParsedCheckerProjectConfig {
  if (options.cached !== undefined) return options.cached;
  return resolveCacheMiss(options);
}

function resolveParsedProjectConfig(options: {
  allowNoInputDiagnostics?: boolean;
  cache: CheckerProjectConfigCache;
  cacheKey: string;
  checkerPresets: CheckerPreset[];
  configPath: string;
  context: CheckerProjectParseContext;
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): ParsedCheckerProjectConfig {
  const cached = getCachedConfig(options.cache, options.cacheKey);
  return resolveCachedProjectConfig({ ...options, cached });
}

function createContextParseRequest(options: {
  allowNoInputDiagnostics?: boolean;
  configPath: string;
  context: CheckerProjectParseContext;
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): {
  allowNoInputDiagnostics?: boolean;
  cacheKey: string;
  checkerPresets: CheckerPreset[];
  configPath: string;
  context: CheckerProjectParseContext;
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
} {
  const checkerPresets = resolveContextCheckerPresets(options.context);
  const cacheKey = createParsedProjectConfigCacheKey({
    allowNoInputDiagnostics: options.allowNoInputDiagnostics,
    checkerPresets,
    configPath: options.configPath,
    extensions: options.context.extensions,
    projectRootDir: options.projectRootDir,
    virtualFiles: options.virtualFiles,
  });
  return { ...options, cacheKey, checkerPresets };
}

export function parseCheckerProjectConfigForContext(options: {
  allowNoInputDiagnostics?: boolean;
  cache?: CheckerProjectConfigCache;
  configPath: string;
  context: CheckerProjectParseContext;
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): ParsedCheckerProjectConfig {
  const request = createContextParseRequest(options);
  if (options.cache === undefined) {
    return createParsedProjectConfig(request);
  }
  return resolveParsedProjectConfig({ ...request, cache: options.cache });
}
