import { normalizeAbsolutePath } from '#utils/path';
import { ResolverFactory } from 'oxc-resolver';
import type ts from 'typescript';
import { createImportAnalysisCaches } from './resolver-caches';
import {
  createOxcResolverProfileIdentityFromResolvedOptions,
  createResolverOptions,
  getRequiredOxcConfigPath,
  getResolverExtensions,
  normalizeContextInput,
} from './resolver-profile';
import type {
  ImportAnalysisCaches,
  ImportAnalysisMetricsRecorder,
  ImportResolveContextInput,
  ResolvedImportContext,
} from './types';

function normalizeResolvedPathForImporter(
  resolvedPath: string,
  containingFile: string,
): string {
  const normalizedPath = normalizeAbsolutePath(resolvedPath);
  const normalizedContainingFile = normalizeAbsolutePath(containingFile);
  if (!normalizedContainingFile.startsWith('/var/')) return normalizedPath;
  if (!normalizedPath.startsWith('/private/var/')) return normalizedPath;
  return normalizedPath.slice('/private'.length);
}

function recordResolverAccess(options: {
  cached: boolean;
  metrics: ImportAnalysisMetricsRecorder | undefined;
}): void {
  options.metrics?.record({
    kind: 'resolver-factory',
    name: options.cached
      ? 'oxc-resolver-factory-hit'
      : 'oxc-resolver-factory-create',
    provider: 'oxc',
  });
}

function getOrCreateResolver(options: {
  caches: ImportAnalysisCaches;
  compilerOptions: ts.CompilerOptions;
  configPath: string;
  extensions: string[];
  metrics: ImportAnalysisMetricsRecorder | undefined;
}): ResolverFactory {
  const identity = createOxcResolverProfileIdentityFromResolvedOptions({
    compilerOptions: options.compilerOptions,
    configPath: options.configPath,
    extensions: options.extensions,
  });
  const cached = options.caches.resolverCache.get(identity.id);
  recordResolverAccess({
    cached: cached !== undefined,
    metrics: options.metrics,
  });
  if (cached !== undefined) return cached;
  const resolver = new ResolverFactory(
    createResolverOptions({
      compilerOptions: options.compilerOptions,
      configPath: options.configPath,
      extensions: options.extensions,
    }),
  );
  options.caches.resolverCache.set(identity.id, resolver);
  return resolver;
}

function recordResolutionRequest(
  metrics: ImportAnalysisMetricsRecorder | undefined,
): void {
  metrics?.record({
    kind: 'request',
    name: 'oxc-resolution',
    provider: 'module-resolution',
  });
}

function resolveWithFactory(options: {
  containingFile: string;
  resolver: ResolverFactory;
  specifier: string;
}): ReturnType<ResolverFactory['resolveFileSync']> | null {
  try {
    return options.resolver.resolveFileSync(
      options.containingFile,
      options.specifier,
    );
  } catch {
    return null;
  }
}

function getResolvedPath(options: {
  containingFile: string;
  resolved: ReturnType<ResolverFactory['resolveFileSync']> | null;
}): string | null {
  const path = options.resolved?.path;
  if (path === undefined) return null;
  return normalizeResolvedPathForImporter(path, options.containingFile);
}

export function resolveModuleNameWithOxcCaches(
  caches: ImportAnalysisCaches,
  options: {
    compilerOptions: ts.CompilerOptions;
    containingFile: string;
    context: ResolvedImportContext;
    metrics?: ImportAnalysisMetricsRecorder;
    specifier: string;
  },
): string | null {
  const configPath = getRequiredOxcConfigPath({
    containingFile: options.containingFile,
    context: options.context,
    specifier: options.specifier,
  });
  const extensions = getResolverExtensions({
    compilerOptions: options.compilerOptions,
    context: options.context,
  });
  const resolver = getOrCreateResolver({
    caches,
    compilerOptions: options.compilerOptions,
    configPath,
    extensions,
    metrics: options.metrics,
  });
  recordResolutionRequest(options.metrics);
  const resolved = resolveWithFactory({
    containingFile: options.containingFile,
    resolver,
    specifier: options.specifier,
  });
  return getResolvedPath({
    containingFile: options.containingFile,
    resolved,
  });
}

export function resolveModuleNameWithOxc(options: {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  context?: ImportResolveContextInput;
  metrics?: ImportAnalysisMetricsRecorder;
  specifier: string;
}): string | null {
  return resolveModuleNameWithOxcCaches(createImportAnalysisCaches(), {
    compilerOptions: options.compilerOptions,
    containingFile: normalizeAbsolutePath(options.containingFile),
    context: normalizeContextInput(options.context),
    metrics: options.metrics,
    specifier: options.specifier,
  });
}
