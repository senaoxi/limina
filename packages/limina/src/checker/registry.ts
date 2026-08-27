import type {
  BuildCheckerName,
  CheckerName,
  CheckerPreset,
} from '#config/runner';
import {
  createTscCommandTarget,
  createTsgoCommandTarget,
  createVueTscCommandTarget,
} from './command-targets';
import {
  getNativeTypeScriptProjectExtensions,
  getTypeScriptCheckerExtensions,
  normalizeExtensions,
  resolveExtensionsForChecker,
} from './extensions';
import { parseProjectConfigWithExtensions } from './project-base';
import {
  parseVueProjectConfig,
  resolveVueProjectExtensionsForChecker,
} from './project-vue';
import type {
  CheckerAdapter,
  CheckerBuildEngine,
  CheckerCapabilityFamily,
} from './types';
import { resolveTypeScriptModuleName } from './typescript-resolution';

function getTypeScriptCommandTarget(
  preset: 'tsc' | 'tsgo',
): CheckerAdapter['createCommandTarget'] {
  return preset === 'tsc' ? createTscCommandTarget : createTsgoCommandTarget;
}

function resolveTypeScriptExtensions(
  options: Parameters<CheckerAdapter['extensions']>[0],
): string[] {
  const extensions = getTypeScriptCheckerExtensions();
  return resolveExtensionsForChecker(options, extensions);
}

function parseTypeScriptProjectConfig(
  options: Parameters<CheckerAdapter['parseProjectConfig']>[0],
): ReturnType<CheckerAdapter['parseProjectConfig']> {
  const extensions = getTypeScriptCheckerExtensions();
  return parseProjectConfigWithExtensions(options, extensions);
}

function createTypeScriptAdapter(options: {
  packageName: string;
  preset: 'tsc' | 'tsgo';
}): CheckerAdapter {
  const createCommandTarget = getTypeScriptCommandTarget(options.preset);
  return {
    createCommandTarget,
    dependencies: {
      externalCheckerPackages:
        options.preset === 'tsgo' ? [options.packageName] : [],
      liminaRuntimePackages:
        options.preset === 'tsc' ? [options.packageName] : [],
    },
    extensions: resolveTypeScriptExtensions,
    execution: 'build',
    emitProjection: 'typescript',
    parseProjectConfig: parseTypeScriptProjectConfig,
    name: options.preset,
    resolveModuleName: resolveTypeScriptModuleName,
    sourceGraph: true,
  };
}

function createVueExtensionsResolver(
  preset: 'vue-tsc',
): CheckerAdapter['extensions'] {
  return (parseOptions) =>
    resolveVueProjectExtensionsForChecker(parseOptions, preset);
}

function createVueProjectParser(
  preset: 'vue-tsc',
): CheckerAdapter['parseProjectConfig'] {
  return (parseOptions) => parseVueProjectConfig(parseOptions, preset);
}

function createVueResolvers(
  preset: 'vue-tsc',
): Pick<CheckerAdapter, 'extensions' | 'parseProjectConfig'> {
  return {
    extensions: createVueExtensionsResolver(preset),
    parseProjectConfig: createVueProjectParser(preset),
  };
}

function createVueAdapterBehavior(
  preset: 'vue-tsc',
): Pick<
  CheckerAdapter,
  'createCommandTarget' | 'extensions' | 'parseProjectConfig'
> {
  const resolvers = createVueResolvers(preset);
  return {
    createCommandTarget: createVueTscCommandTarget,
    extensions: resolvers.extensions,
    parseProjectConfig: resolvers.parseProjectConfig,
  };
}

function createVueAdapter(options: {
  execution: 'build' | 'typecheck';
  packageNames: string[];
  preset: 'vue-tsc';
}): CheckerAdapter {
  const behavior = createVueAdapterBehavior(options.preset);
  return {
    ...behavior,
    dependencies: {
      externalCheckerPackages: options.packageNames,
      liminaRuntimePackages: [],
    },
    execution: options.execution,
    emitProjection: 'vue-bounded',
    name: options.preset,
    resolveModuleName: resolveTypeScriptModuleName,
    sourceGraph: true,
  };
}

const builtinCheckerAdapters = {
  tsc: createTypeScriptAdapter({ packageName: 'typescript', preset: 'tsc' }),
  tsgo: createTypeScriptAdapter({
    packageName: '@typescript/native-preview',
    preset: 'tsgo',
  }),
  'vue-tsc': createVueAdapter({
    execution: 'build',
    packageNames: ['vue-tsc'],
    preset: 'vue-tsc',
  }),
} satisfies Record<BuildCheckerName, CheckerAdapter>;

function isBuildCheckerName(value: string): value is BuildCheckerName {
  return Object.hasOwn(builtinCheckerAdapters, value);
}

export function getCheckerAdapter(preset: string): CheckerAdapter | null {
  if (!isBuildCheckerName(preset)) return null;
  return builtinCheckerAdapters[preset];
}

const checkerBuildEngines = {
  tsc: 'tsc',
  tsgo: 'tsgo',
  'vue-tsc': 'vue-tsc',
} satisfies Record<BuildCheckerName, CheckerBuildEngine>;

const checkerCapabilityFamilies = {
  astro: 'unknown',
  'svelte-check': 'svelte',
  tsc: 'typescript-native',
  tsgo: 'typescript-native',
  'vue-tsc': 'vue',
} satisfies Record<CheckerName, CheckerCapabilityFamily>;

function getKnownBuildEngine(
  preset: CheckerPreset,
): CheckerBuildEngine | undefined {
  if (!isBuildCheckerName(preset)) return undefined;
  return checkerBuildEngines[preset];
}

export function getCheckerBuildEngine(
  preset: CheckerPreset,
): CheckerBuildEngine {
  const engine = getKnownBuildEngine(preset);
  return engine === undefined ? 'unknown' : engine;
}

function getKnownCapabilityFamily(
  preset: CheckerPreset,
): CheckerCapabilityFamily | undefined {
  if (!Object.hasOwn(checkerCapabilityFamilies, preset)) return undefined;
  return checkerCapabilityFamilies[preset as CheckerName];
}

export function getCheckerCapabilityFamily(
  preset: CheckerPreset,
): CheckerCapabilityFamily {
  const family = getKnownCapabilityFamily(preset);
  return family === undefined ? 'unknown' : family;
}

export function isBuildCapablePreset(preset: CheckerPreset): boolean {
  const adapter = getCheckerAdapter(preset);
  if (adapter === null) return false;
  return adapter.execution === 'build';
}

function getBuildAdapter(preset: CheckerPreset): CheckerAdapter | null {
  const adapter = getCheckerAdapter(preset);
  if (adapter === null) return null;
  return adapter.execution === 'build' ? adapter : null;
}

function addVueExtension(
  preset: CheckerPreset,
  nativeExtensions: string[],
): string[] {
  if (preset !== 'vue-tsc') return nativeExtensions;
  return normalizeExtensions([...nativeExtensions, '.vue']);
}

function getSupportedBuildExtensions(
  preset: CheckerPreset,
  adapter: CheckerAdapter | null,
): string[] {
  if (adapter === null) return [];
  const nativeExtensions = getNativeTypeScriptProjectExtensions();
  return addVueExtension(preset, nativeExtensions);
}

export function getBuildCheckerSupportedExtensions(
  preset: CheckerPreset,
): string[] {
  const adapter = getBuildAdapter(preset);
  return getSupportedBuildExtensions(preset, adapter);
}

export function isCheckerCacheReusable(options: {
  consumer: string;
  provider: string;
}): boolean {
  if (options.consumer === options.provider) return true;
  return options.consumer === 'vue-tsc' && options.provider === 'tsc';
}
