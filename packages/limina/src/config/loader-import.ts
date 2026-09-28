import { pathToFileURL } from 'node:url';
import type * as tsxEsmApi from 'tsx/esm/api';
import type { LiminaConfigLoader } from './root-types';

function isConfigLoader(value: unknown): value is LiminaConfigLoader {
  if (value === 'native') return true;
  return value === 'tsx';
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
  if (value === null) return false;
  return typeof value === 'object';
}

function getErrorCode(error: unknown): unknown {
  if (!isObject(error)) return undefined;
  if (!('code' in error)) return undefined;
  return (error as { code?: unknown }).code;
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
  if (!(error instanceof Error)) return false;
  if (typeof error.stack !== 'string') return false;
  return error.stack.includes('node:internal/modules/esm/translators');
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
  if (hasDefault(value)) return value.default;
  return value;
}

function unwrapModuleDefault(module: unknown): unknown {
  if (!isObject(module)) return module;
  if (!isModuleNamespace(module)) return module;
  return getDefaultOrSelf(module);
}

function isSingleDefaultObject(value: object): value is { default: unknown } {
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;
  if (!hasDefault(value)) return false;
  return Object.keys(value).length === 1;
}

function unwrapSingleDefaultObject(value: object): unknown {
  if (isSingleDefaultObject(value)) return value.default;
  return value;
}

function unwrapTsxConfigExport(module: unknown): unknown {
  const value = unwrapModuleDefault(module);
  if (!isObject(value)) return value;
  return unwrapSingleDefaultObject(value);
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

async function nativeImportConfig(configPath: string): Promise<unknown> {
  const url = pathToFileURL(configPath);
  url.searchParams.set('t', String(Date.now()));
  try {
    return unwrapModuleDefault(await import(url.href));
  } catch (error) {
    if (shouldSuggestTsxLoader(error)) throw createNativeLoaderError(error);
    throw error;
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

async function tsxImportConfig(configPath: string): Promise<unknown> {
  const tsxApi = await importTsxApi();
  const module = await tsxApi.tsImport(
    pathToFileURL(configPath).href,
    import.meta.url,
  );
  return unwrapTsxConfigExport(module);
}

export async function loadConfigModule(
  configPath: string,
  configLoader: unknown,
): Promise<unknown> {
  const loader = resolveConfigLoader(configLoader);
  if (loader === 'native') return nativeImportConfig(configPath);
  return tsxImportConfig(configPath);
}
