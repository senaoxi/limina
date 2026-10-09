import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as tsxEsmApi from 'tsx/esm/api';
import type { LiminaConfigLoader } from './root-types';

function isConfigLoader(value: unknown): value is LiminaConfigLoader {
  return value === 'native' || value === 'tsx';
}

export function resolveConfigLoader(configLoader: unknown): LiminaConfigLoader {
  if (configLoader === undefined) return 'native';
  if (isConfigLoader(configLoader)) return configLoader;
  throw new Error(
    `Unsupported Limina config loader "${String(configLoader)}". Expected one of: native, tsx.`,
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function getErrorCode(error: unknown): unknown {
  if (!isObject(error)) return undefined;
  return 'code' in error ? (error as { code?: unknown }).code : undefined;
}

function hasSuggestionCode(error: unknown): boolean {
  return new Set([
    'ERR_UNKNOWN_FILE_EXTENSION',
    'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
  ]).has(String(getErrorCode(error)));
}

function hasSuggestionMessage(error: unknown): boolean {
  const message = getErrorMessage(error);
  return [
    'Unknown file extension ".ts"',
    'Unknown file extension ".mts"',
    'Cannot find module',
  ].some((fragment) => message.includes(fragment));
}

function hasTranslatorStack(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof error.stack === 'string' &&
    error.stack.includes('node:internal/modules/esm/translators')
  );
}

function shouldSuggestTsxLoader(error: unknown): boolean {
  return [
    hasSuggestionCode(error),
    hasSuggestionMessage(error),
    hasTranslatorStack(error),
  ].some(Boolean);
}

function isModuleNamespace(value: object): boolean {
  return Object.prototype.toString.call(value) === '[object Module]';
}

function hasDefault(value: object): value is { default: unknown } {
  return 'default' in value;
}

function getDefaultOrSelf(value: object): unknown {
  return hasDefault(value) ? value.default : value;
}

function unwrapModuleDefault(module: unknown): unknown {
  if (!isObject(module)) return module;
  return isModuleNamespace(module) ? getDefaultOrSelf(module) : module;
}

function isSingleDefaultObject(value: object): value is { default: unknown } {
  return (
    Object.prototype.toString.call(value) === '[object Object]' &&
    hasDefault(value) &&
    Object.keys(value).length === 1
  );
}

function unwrapSingleDefaultObject(value: object): unknown {
  return isSingleDefaultObject(value) ? value.default : value;
}

function unwrapTsxConfigExport(module: unknown): unknown {
  const value = unwrapModuleDefault(module);
  return isObject(value) ? unwrapSingleDefaultObject(value) : value;
}

function createNativeLoaderError(error: unknown): Error {
  return new Error(
    [
      'Failed to load the Limina config file with the native loader.',
      'Try setting the --config-loader CLI flag to `tsx`.',
      '',
      getErrorMessage(error),
    ].join('\n'),
    { cause: error },
  );
}

async function nativeImportConfig(entryURL: string): Promise<unknown> {
  try {
    return await nativeLoadConfig(entryURL);
  } catch (error) {
    if (shouldSuggestTsxLoader(error)) throw createNativeLoaderError(error);
    throw error;
  }
}
async function nativeLoadConfig(entryURL: string): Promise<unknown> {
  return shouldRequireEntry(entryURL)
    ? nativeRequireConfig(entryURL)
    : unwrapModuleDefault(await import(entryURL));
}
async function nativeRequireConfig(entryURL: string): Promise<unknown> {
  try {
    return unwrapModuleDefault(
      createRequire(import.meta.url)(fileURLToPath(entryURL)),
    );
  } catch (error) {
    if (getErrorCode(error) === 'ERR_REQUIRE_ASYNC_MODULE')
      return unwrapModuleDefault(await import(entryURL));
    throw error;
  }
}
function shouldRequireEntry(entryURL: string): boolean {
  const format = nativeModuleFormat(entryURL);
  return format === undefined
    ? ['.js', '.ts'].includes(path.extname(fileURLToPath(entryURL)))
    : ['commonjs', 'commonjs-typescript'].includes(format);
}
function nativeModuleFormat(entryURL: string): string | undefined {
  let format: string | undefined;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (specifier === entryURL) format = result.format ?? undefined;
      return result;
    },
  });
  try {
    import.meta.resolve(entryURL);
    return format;
  } finally {
    hook.deregister();
  }
}

async function importTsxApi(): Promise<typeof tsxEsmApi> {
  try {
    return await import('tsx/esm/api');
  } catch (error) {
    throw new Error(
      [
        'Failed to load the Limina config file with the tsx loader.',
        'Please install `tsx` in the current workspace before using --config-loader tsx.',
      ].join('\n'),
      { cause: error },
    );
  }
}

interface LoadModuleOptions<T> {
  entryURL: string;
  namespace?: string;
  evaluate(module: unknown): Promise<T>;
}
async function tsxImportConfig<T>(options: LoadModuleOptions<T>): Promise<T> {
  const tsxApi = await importTsxApi();
  const module = await tsxLoadModule(
    tsxApi,
    options.entryURL,
    options.namespace!,
  );
  return options.evaluate(unwrapTsxConfigExport(module));
}
async function tsxLoadModule(
  api: typeof tsxEsmApi,
  entryURL: string,
  namespace: string,
): Promise<unknown> {
  return shouldRequireEntry(entryURL)
    ? tsxRequireModule(entryURL, namespace)
    : api.register({ namespace }).import(entryURL, import.meta.url);
}
async function tsxRequireModule(
  entryURL: string,
  namespace: string,
): Promise<unknown> {
  const api = await import('tsx/cjs/api');
  const scope = api.register({ namespace });
  // Keep the scope alive, as tsImport does, for continuing config callbacks.
  return scope.require(
    fileURLToPath(entryURL) + new URL(entryURL).search,
    import.meta.url,
  );
}
export async function loadConfigModule<T>(
  configLoader: unknown,
  options: LoadModuleOptions<T>,
): Promise<T> {
  const loader = resolveConfigLoader(configLoader);
  return loader === 'native'
    ? options.evaluate(await nativeImportConfig(options.entryURL))
    : tsxImportConfig(options);
}
