import type { CheckerPreset } from '#config/runner';
import { compareCodeUnits, uniqueValues } from '#utils/collections';
import {
  createParsedProjectConfigCacheKey,
  resolveContextCheckerPresets,
} from './context-cache-key';
import { normalizeExtensions } from './extensions';
import { cloneParsedCheckerProjectConfig } from './project-base';
import { getCheckerAdapter } from './registry';
import type {
  CheckerConfigClosureEntry,
  CheckerProjectParseContext,
  ParsedCheckerProjectConfig,
} from './types';

function assertConfigClosureEntryCompatible(
  existing: CheckerConfigClosureEntry | undefined,
  entry: CheckerConfigClosureEntry,
): void {
  if (existing === undefined || existing.contentHash === entry.contentHash)
    return;
  throw new Error(
    `Checker parsers observed conflicting config content for ${entry.filePath}.`,
  );
}

function mergeConfigClosure(
  configs: readonly ParsedCheckerProjectConfig[],
): CheckerConfigClosureEntry[] {
  const entries = new Map<string, CheckerConfigClosureEntry>();
  const configClosure = configs.flatMap((config) => config.configClosure);
  for (const entry of configClosure) {
    const existing = entries.get(entry.filePath);
    assertConfigClosureEntryCompatible(existing, entry);
    entries.set(entry.filePath, { ...entry });
  }
  return entries
    .values()
    .toArray()
    .sort((left, right) => compareCodeUnits(left.filePath, right.filePath));
}

export class CheckerProjectConfigCache {
  readonly #entries = new Map<string, ParsedCheckerProjectConfig>();
  readonly #observe:
    | ((
        config: ParsedCheckerProjectConfig,
        virtualFiles?: ReadonlyMap<string, string>,
      ) => void)
    | undefined;
  readonly generation: number;

  constructor(
    generation = 0,
    observe?: (
      config: ParsedCheckerProjectConfig,
      virtualFiles?: ReadonlyMap<string, string>,
    ) => void,
  ) {
    this.generation = generation;
    this.#observe = observe;
  }

  get(cacheKey: string): ParsedCheckerProjectConfig | undefined {
    const cached = this.#entries.get(cacheKey);
    return cached === undefined
      ? undefined
      : cloneParsedCheckerProjectConfig(cached);
  }

  set(
    cacheKey: string,
    config: ParsedCheckerProjectConfig,
    virtualFiles?: ReadonlyMap<string, string>,
  ): ParsedCheckerProjectConfig {
    this.#observe?.(config, virtualFiles);
    this.#entries.set(cacheKey, cloneParsedCheckerProjectConfig(config));
    return cloneParsedCheckerProjectConfig(config);
  }
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
    configClosure: mergeConfigClosure(options.parsedConfigs),
    extensions: normalizeExtensions([
      ...options.extensions,
      ...options.parsedConfigs.flatMap((config) => config.extensions),
    ]),
    fileNames: uniqueValues(
      options.parsedConfigs.flatMap((config) => config.fileNames),
    ).sort(compareCodeUnits),
    options: firstConfig.options,
    vueSemanticIdentity: options.parsedConfigs.find(
      (config) => config.vueSemanticIdentity !== undefined,
    )?.vueSemanticIdentity,
  };
}

function parseWithPreset(options: {
  allowNoInputDiagnostics?: boolean;
  configPath: string;
  extensions: string[];
  generation: number;
  preset: CheckerPreset;
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
  vueSemanticIdentity?: CheckerProjectParseContext['vueSemanticIdentity'];
}): ParsedCheckerProjectConfig {
  const adapter = getCheckerAdapter(options.preset);
  if (adapter === null) {
    throw new Error(`Checker preset "${options.preset}" is not supported.`);
  }
  return adapter.parseProjectConfig({
    allowNoInputDiagnostics: options.allowNoInputDiagnostics,
    configPath: options.configPath,
    extensions: options.extensions,
    generation: options.generation,
    projectRootDir: options.projectRootDir,
    virtualFiles: options.virtualFiles,
    vueSemanticIdentity: options.vueSemanticIdentity,
  });
}

function parseContextConfigs(options: {
  allowNoInputDiagnostics?: boolean;
  checkerPresets: CheckerPreset[];
  configPath: string;
  context: CheckerProjectParseContext;
  projectRootDir: string;
  generation: number;
  virtualFiles?: ReadonlyMap<string, string>;
}): ParsedCheckerProjectConfig[] {
  return options.checkerPresets.map((preset) =>
    parseWithPreset({
      allowNoInputDiagnostics: options.allowNoInputDiagnostics,
      configPath: options.configPath,
      extensions: options.context.extensions,
      generation: options.generation,
      preset,
      projectRootDir: options.projectRootDir,
      virtualFiles: options.virtualFiles,
      vueSemanticIdentity: options.context.vueSemanticIdentity,
    }),
  );
}

function getCachedConfig(
  cache: CheckerProjectConfigCache,
  cacheKey: string,
): ParsedCheckerProjectConfig | undefined {
  return cache.get(cacheKey);
}

function createParsedProjectConfig(options: {
  allowNoInputDiagnostics?: boolean;
  checkerPresets: CheckerPreset[];
  configPath: string;
  context: CheckerProjectParseContext;
  projectRootDir: string;
  generation: number;
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
  generation: number;
  virtualFiles?: ReadonlyMap<string, string>;
}): ParsedCheckerProjectConfig {
  const parsedConfig = createParsedProjectConfig(options);
  return options.cache.set(
    options.cacheKey,
    parsedConfig,
    options.virtualFiles,
  );
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
  generation: number;
  virtualFiles?: ReadonlyMap<string, string>;
}): ParsedCheckerProjectConfig {
  return options.cached === undefined
    ? resolveCacheMiss(options)
    : options.cached;
}

function resolveParsedProjectConfig(options: {
  allowNoInputDiagnostics?: boolean;
  cache: CheckerProjectConfigCache;
  cacheKey: string;
  checkerPresets: CheckerPreset[];
  configPath: string;
  context: CheckerProjectParseContext;
  projectRootDir: string;
  generation: number;
  virtualFiles?: ReadonlyMap<string, string>;
}): ParsedCheckerProjectConfig {
  const cached = getCachedConfig(options.cache, options.cacheKey);
  return resolveCachedProjectConfig({ ...options, cached });
}

function createContextParseRequest(options: {
  allowNoInputDiagnostics?: boolean;
  cache?: CheckerProjectConfigCache;
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
  generation: number;
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
} {
  const checkerPresets = resolveContextCheckerPresets(options.context);
  const generation = options.cache?.generation ?? 0;
  const cacheKey = createParsedProjectConfigCacheKey({
    allowNoInputDiagnostics: options.allowNoInputDiagnostics,
    checkerPresets,
    configPath: options.configPath,
    extensions: options.context.extensions,
    generation,
    projectRootDir: options.projectRootDir,
    virtualFiles: options.virtualFiles,
    vueSemanticIdentity: options.context.vueSemanticIdentity,
  });
  return { ...options, cacheKey, checkerPresets, generation };
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
  return options.cache === undefined
    ? createParsedProjectConfig(request)
    : resolveParsedProjectConfig({ ...request, cache: options.cache });
}
