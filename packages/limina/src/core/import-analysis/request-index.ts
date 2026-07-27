import { normalizeAbsolutePath } from '#utils/path';
import {
  createLazyModuleResolutionRecord,
  createModuleResolutionRequestKey,
  getModuleResolverIdentity,
} from './resolver-caches';
import { normalizeContextInput } from './resolver-profile';
import type {
  ImportAnalysisCaches,
  ImportAnalysisMetricsRecorder,
  ImportResolutionArguments,
  NormalizedModuleResolutionRequest,
} from './types';

type ResolutionKind = 'internal-import' | 'oxc' | 'typescript';

export interface ModuleResolutionRequestIndex {
  getRequest(
    ...args: ImportResolutionArguments
  ): NormalizedModuleResolutionRequest;
  recordIndexAccess(kind: ResolutionKind, hit: boolean): void;
  recordRequest(kind: ResolutionKind): void;
}

function recordRequest(options: {
  kind: ResolutionKind;
  metrics: ImportAnalysisMetricsRecorder | undefined;
}): void {
  options.metrics?.record({
    kind: options.kind,
    name: 'module-resolution-request',
    provider: 'import-analysis',
  });
}

function recordIndexAccess(options: {
  hit: boolean;
  kind: ResolutionKind;
  metrics: ImportAnalysisMetricsRecorder | undefined;
}): void {
  options.metrics?.record({
    kind: options.kind,
    name: options.hit
      ? 'module-resolution-index-hit'
      : 'module-resolution-index-miss',
    provider: 'import-analysis',
  });
}

function getOrCreateRecord(options: {
  cacheKey: string;
  caches: ImportAnalysisCaches;
}) {
  const cached = options.caches.moduleResolutionIndex.get(options.cacheKey);
  if (cached !== undefined) return cached;
  const record = createLazyModuleResolutionRecord();
  options.caches.moduleResolutionIndex.set(options.cacheKey, record);
  return record;
}

export function createModuleResolutionRequestIndex(options: {
  caches: ImportAnalysisCaches;
  metrics: ImportAnalysisMetricsRecorder | undefined;
}): ModuleResolutionRequestIndex {
  return {
    getRequest: (...args) => {
      const [specifier, containingFile, compilerOptions, contextOrExtensions] =
        args;
      const normalizedContainingFile = normalizeAbsolutePath(containingFile);
      const context = normalizeContextInput(contextOrExtensions);
      const cacheKey = createModuleResolutionRequestKey({
        containingFile: normalizedContainingFile,
        resolverIdentity: getModuleResolverIdentity(options.caches, {
          compilerOptions,
          context,
        }),
        specifier,
      });
      return {
        compilerOptions,
        containingFile: normalizedContainingFile,
        context,
        record: getOrCreateRecord({ cacheKey, caches: options.caches }),
        specifier,
      };
    },
    recordIndexAccess: (kind, hit) =>
      recordIndexAccess({ hit, kind, metrics: options.metrics }),
    recordRequest: (kind) => recordRequest({ kind, metrics: options.metrics }),
  };
}
