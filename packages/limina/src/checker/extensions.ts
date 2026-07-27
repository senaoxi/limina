import { uniqueValues } from '#utils/collections';
import ts from 'typescript';
import type { CheckerProjectConfigParseOptions } from './types';

type TypeScriptExtensionGroups = readonly (readonly string[])[];

interface TypeScriptExtensionApi {
  getSupportedExtensions: (
    options?: ts.CompilerOptions,
    extraFileExtensions?: readonly ts.FileExtensionInfo[],
  ) => TypeScriptExtensionGroups;
  getSupportedExtensionsWithJsonIfResolveJsonModule: (
    options: ts.CompilerOptions | undefined,
    supportedExtensions: TypeScriptExtensionGroups,
  ) => TypeScriptExtensionGroups;
}

function isTypeScriptExtensionApi(
  api: Partial<TypeScriptExtensionApi>,
): api is TypeScriptExtensionApi {
  if (typeof api.getSupportedExtensions !== 'function') return false;
  return (
    typeof api.getSupportedExtensionsWithJsonIfResolveJsonModule === 'function'
  );
}

function getTypeScriptExtensionApi(): TypeScriptExtensionApi {
  const api = ts as typeof ts & Partial<TypeScriptExtensionApi>;
  if (isTypeScriptExtensionApi(api)) return api;
  throw new TypeError(
    'Unable to resolve TypeScript checker extensions: the TypeScript compiler API does not expose supported extension metadata.',
  );
}

function flattenTypeScriptExtensionGroups(
  groups: TypeScriptExtensionGroups,
): string[] {
  return groups.flatMap((group) => [...group]);
}

function getCompilerExtensions(options: ts.CompilerOptions): string[] {
  const api = getTypeScriptExtensionApi();
  return normalizeExtensions(
    flattenTypeScriptExtensionGroups(
      api.getSupportedExtensionsWithJsonIfResolveJsonModule(
        options,
        api.getSupportedExtensions(options),
      ),
    ),
  );
}

export function getTypeScriptCheckerExtensions(): string[] {
  return getCompilerExtensions({ resolveJsonModule: true });
}

export function getNativeTypeScriptProjectExtensions(): string[] {
  return getCompilerExtensions({ allowJs: true, resolveJsonModule: true });
}

export function getSvelteCheckerExtensions(): string[] {
  return normalizeExtensions([...getTypeScriptCheckerExtensions(), '.svelte']);
}

export function isNativeTypeScriptProjectInput(fileName: string): boolean {
  const normalizedFileName = fileName.toLowerCase();
  return getNativeTypeScriptProjectExtensions().some((extension) =>
    normalizedFileName.endsWith(extension.toLowerCase()),
  );
}

function isExtraExtension(
  extension: string,
  nativeExtensions: ReadonlySet<string>,
): boolean {
  return !nativeExtensions.has(extension);
}

function normalizeExtensionName(extension: string): string {
  return extension.startsWith('.') ? extension.slice(1) : extension;
}

function createExtraFileExtension(extension: string): ts.FileExtensionInfo {
  return {
    extension: normalizeExtensionName(extension),
    isMixedContent: true,
    scriptKind: ts.ScriptKind.Deferred,
  };
}

export function createExtraFileExtensions(
  extensions: string[],
): ts.FileExtensionInfo[] {
  const nativeValues = getNativeTypeScriptProjectExtensions();
  const nativeExtensions = new Set(nativeValues);
  const extraExtensions = extensions.filter((extension) =>
    isExtraExtension(extension, nativeExtensions),
  );
  return extraExtensions.map(createExtraFileExtension);
}

function getConfiguredExtensions(
  options: CheckerProjectConfigParseOptions,
): string[] | undefined {
  const extensions = options.extensions;
  if (extensions === undefined) return undefined;
  return extensions.length > 0 ? extensions : undefined;
}

function selectCheckerExtensions(
  configured: string[] | undefined,
  defaults: string[],
): string[] {
  return configured === undefined ? defaults : configured;
}

export function resolveExtensionsForChecker(
  options: CheckerProjectConfigParseOptions,
  extensions: string[],
): string[] {
  const configured = getConfiguredExtensions(options);
  const selected = selectCheckerExtensions(configured, extensions);
  return normalizeExtensions(selected);
}

function compareExtensions(left: string, right: string): number {
  const lengthDelta = right.length - left.length;
  if (lengthDelta !== 0) return lengthDelta;
  return left.localeCompare(right);
}

export function normalizeExtensions(extensions: string[]): string[] {
  const values = uniqueValues(extensions);
  values.sort(compareExtensions);
  return values;
}
