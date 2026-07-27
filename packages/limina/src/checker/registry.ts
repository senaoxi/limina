import type { BuiltinCheckerPreset, CheckerPreset } from '#config/runner';
import {
  createSvelteCheckCommandTarget,
  createTscCommandTarget,
  createTsgoCommandTarget,
  createVueTscCommandTarget,
  createVueTsgoCommandTarget,
} from './command-targets';
import {
  getNativeTypeScriptProjectExtensions,
  getSvelteCheckerExtensions,
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

function resolveSvelteExtensions(
  options: Parameters<CheckerAdapter['extensions']>[0],
): string[] {
  const extensions = getSvelteCheckerExtensions();
  return resolveExtensionsForChecker(options, extensions);
}

function parseSvelteProjectConfig(
  options: Parameters<CheckerAdapter['parseProjectConfig']>[0],
): ReturnType<CheckerAdapter['parseProjectConfig']> {
  const extensions = getSvelteCheckerExtensions();
  return parseProjectConfigWithExtensions(options, extensions);
}

function createSvelteAdapter(): CheckerAdapter {
  return {
    createCommandTarget: createSvelteCheckCommandTarget,
    extensions: resolveSvelteExtensions,
    execution: 'typecheck',
    emitProjection: 'typescript',
    packageNames: ['svelte-check'],
    parseProjectConfig: parseSvelteProjectConfig,
    preset: 'svelte-check',
    resolveModuleName: resolveTypeScriptModuleName,
    sourceGraph: false,
  };
}

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
    extensions: resolveTypeScriptExtensions,
    execution: 'build',
    emitProjection: 'typescript',
    packageNames: [options.packageName],
    parseProjectConfig: parseTypeScriptProjectConfig,
    preset: options.preset,
    resolveModuleName: resolveTypeScriptModuleName,
    sourceGraph: true,
  };
}

function getVueCommandTarget(
  preset: 'vue-tsc' | 'vue-tsgo',
): CheckerAdapter['createCommandTarget'] {
  return preset === 'vue-tsc'
    ? createVueTscCommandTarget
    : createVueTsgoCommandTarget;
}

function createVueExtensionsResolver(
  preset: 'vue-tsc' | 'vue-tsgo',
): CheckerAdapter['extensions'] {
  return (parseOptions) =>
    resolveVueProjectExtensionsForChecker(parseOptions, preset);
}

function createVueProjectParser(
  preset: 'vue-tsc' | 'vue-tsgo',
): CheckerAdapter['parseProjectConfig'] {
  return (parseOptions) => parseVueProjectConfig(parseOptions, preset);
}

function createVueResolvers(
  preset: 'vue-tsc' | 'vue-tsgo',
): Pick<CheckerAdapter, 'extensions' | 'parseProjectConfig'> {
  return {
    extensions: createVueExtensionsResolver(preset),
    parseProjectConfig: createVueProjectParser(preset),
  };
}

function createVueAdapterBehavior(
  preset: 'vue-tsc' | 'vue-tsgo',
): Pick<
  CheckerAdapter,
  'createCommandTarget' | 'extensions' | 'parseProjectConfig'
> {
  const resolvers = createVueResolvers(preset);
  return {
    createCommandTarget: getVueCommandTarget(preset),
    extensions: resolvers.extensions,
    parseProjectConfig: resolvers.parseProjectConfig,
  };
}

function createVueAdapter(options: {
  execution: 'build' | 'typecheck';
  packageNames: string[];
  preset: 'vue-tsc' | 'vue-tsgo';
}): CheckerAdapter {
  const behavior = createVueAdapterBehavior(options.preset);
  return {
    ...behavior,
    execution: options.execution,
    emitProjection: 'vue-bounded',
    packageNames: options.packageNames,
    preset: options.preset,
    resolveModuleName: resolveTypeScriptModuleName,
    sourceGraph: true,
  };
}

const builtinCheckerAdapters = {
  'svelte-check': createSvelteAdapter(),
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
  'vue-tsgo': createVueAdapter({
    execution: 'typecheck',
    packageNames: ['vue-tsgo', '@typescript/native-preview'],
    preset: 'vue-tsgo',
  }),
} satisfies Record<BuiltinCheckerPreset, CheckerAdapter>;

function isBuiltinCheckerPreset(value: string): value is BuiltinCheckerPreset {
  return Object.hasOwn(builtinCheckerAdapters, value);
}

export function getCheckerAdapter(preset: string): CheckerAdapter | null {
  if (!isBuiltinCheckerPreset(preset)) return null;
  return builtinCheckerAdapters[preset];
}

const checkerBuildEngines = {
  'svelte-check': 'typecheck-only',
  tsc: 'tsc',
  tsgo: 'tsgo',
  'vue-tsc': 'vue-tsc',
  'vue-tsgo': 'typecheck-only',
} satisfies Record<BuiltinCheckerPreset, CheckerBuildEngine>;

const checkerCapabilityFamilies = {
  'svelte-check': 'svelte',
  tsc: 'typescript-native',
  tsgo: 'typescript-native',
  'vue-tsc': 'vue',
  'vue-tsgo': 'vue',
} satisfies Record<BuiltinCheckerPreset, CheckerCapabilityFamily>;

function getKnownBuildEngine(
  preset: CheckerPreset,
): CheckerBuildEngine | undefined {
  if (!isBuiltinCheckerPreset(preset)) return undefined;
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
  if (!isBuiltinCheckerPreset(preset)) return undefined;
  return checkerCapabilityFamilies[preset];
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
