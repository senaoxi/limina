import {
  resolvePathMappedModuleCandidate,
  resolveRelativeModuleCandidate,
} from '#utils/module-resolution';
import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import { getTypeScriptCheckerExtensions } from './extensions';
import { resolvePackageExportModuleCandidate } from './package-exports';
import type {
  CheckerModuleResolveOptions,
  ResolvedCheckerModuleName,
} from './types';

function recordResolutionRequest(options: CheckerModuleResolveOptions): void {
  options.metrics?.record({
    kind: 'request',
    name: 'typescript-resolution',
    provider: 'module-resolution',
  });
}

function hasNativeCacheHit(options: CheckerModuleResolveOptions): boolean {
  const cache = options.moduleResolutionCache;
  if (cache === undefined) return false;
  return (
    ts.resolveModuleNameFromCache(
      options.specifier,
      options.containingFile,
      cache,
    ) !== undefined
  );
}

function getCacheMetricName(
  options: CheckerModuleResolveOptions,
):
  | 'typescript-module-resolution-cache-hit'
  | 'typescript-module-resolution-cache-miss' {
  return hasNativeCacheHit(options)
    ? 'typescript-module-resolution-cache-hit'
    : 'typescript-module-resolution-cache-miss';
}

function recordCacheState(options: CheckerModuleResolveOptions): void {
  options.metrics?.record({
    kind: 'module-resolution',
    name: getCacheMetricName(options),
    provider: 'typescript',
  });
}

function resolveNativeModule(
  options: CheckerModuleResolveOptions,
): ResolvedCheckerModuleName | null {
  const resolved = ts.resolveModuleName(
    options.specifier,
    options.containingFile,
    options.compilerOptions,
    ts.sys,
    options.moduleResolutionCache,
  ).resolvedModule;
  if (resolved === undefined) return null;
  return {
    isExternalLibraryImport: resolved.isExternalLibraryImport === true,
    resolvedBy: 'typescript',
    resolvedFileName: normalizeAbsolutePath(resolved.resolvedFileName),
  };
}

function getCheckerOnlyExtensions(extensions: readonly string[]): string[] {
  const typeScriptExtensions = new Set(getTypeScriptCheckerExtensions());
  return extensions.filter((extension) => !typeScriptExtensions.has(extension));
}

function resolveNonRelativeCheckerSource(options: {
  checkerOnlyExtensions: readonly string[];
  resolveOptions: CheckerModuleResolveOptions;
}): string | null {
  const mapped = resolvePathMappedModuleCandidate({
    compilerOptions: options.resolveOptions.compilerOptions,
    extensions: options.checkerOnlyExtensions,
    specifier: options.resolveOptions.specifier,
  });
  if (mapped !== null) return mapped;
  return resolvePackageExportModuleCandidate({
    containingFile: options.resolveOptions.containingFile,
    extensions: options.checkerOnlyExtensions,
    specifier: options.resolveOptions.specifier,
  });
}

function resolveCheckerSourcePath(options: {
  checkerOnlyExtensions: readonly string[];
  resolveOptions: CheckerModuleResolveOptions;
}): string | null {
  const relative = resolveRelativeModuleCandidate({
    containingFile: options.resolveOptions.containingFile,
    extensions: options.checkerOnlyExtensions,
    specifier: options.resolveOptions.specifier,
  });
  if (relative !== null) return relative;
  return resolveNonRelativeCheckerSource(options);
}

function isCheckerSourcePath(
  filePath: string,
  extensions: readonly string[],
): boolean {
  const normalized = filePath.toLowerCase();
  return extensions.some((extension) =>
    normalized.endsWith(extension.toLowerCase()),
  );
}

function createCheckerSourceResolution(options: {
  checkerOnlyExtensions: readonly string[];
  resolvedFileName: string | null;
}): ResolvedCheckerModuleName | null {
  const resolvedFileName = options.resolvedFileName;
  if (resolvedFileName === null) return null;
  if (!isCheckerSourcePath(resolvedFileName, options.checkerOnlyExtensions)) {
    return null;
  }
  return {
    isExternalLibraryImport: false,
    resolvedBy: 'checker-source',
    resolvedFileName,
  };
}

function resolveCheckerSourceModuleName(
  options: CheckerModuleResolveOptions,
): ResolvedCheckerModuleName | null {
  const checkerOnlyExtensions = getCheckerOnlyExtensions(options.extensions);
  if (checkerOnlyExtensions.length === 0) return null;
  return createCheckerSourceResolution({
    checkerOnlyExtensions,
    resolvedFileName: resolveCheckerSourcePath({
      checkerOnlyExtensions,
      resolveOptions: options,
    }),
  });
}

function preferNativeResolution(options: {
  checkerResolution: ResolvedCheckerModuleName | null;
  nativeResolution: ResolvedCheckerModuleName | null;
}): ResolvedCheckerModuleName | null {
  return options.nativeResolution === null
    ? options.checkerResolution
    : options.nativeResolution;
}

export function resolveTypeScriptModuleNameDetailed(
  options: CheckerModuleResolveOptions,
): ResolvedCheckerModuleName | null {
  recordResolutionRequest(options);
  recordCacheState(options);
  return preferNativeResolution({
    checkerResolution: resolveCheckerSourceModuleName(options),
    nativeResolution: resolveNativeModule(options),
  });
}

export function resolveTypeScriptModuleName(
  options: CheckerModuleResolveOptions,
): string | null {
  const resolved = resolveTypeScriptModuleNameDetailed(options);
  return resolved === null ? null : resolved.resolvedFileName;
}
