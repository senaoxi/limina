import type { VueSourceProfile } from '#checkers';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import { readFileSync } from 'node:fs';
import { collectTypeScriptSourceTextImports } from '../import-analysis/typescript-imports';
import { cloneSourceEvidence } from './cache';
import type { SourceEvidence } from './contracts';

const typeScriptExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);

function getExtension(filePath: string): string {
  const index = filePath.lastIndexOf('.');
  return index === -1 ? '' : filePath.slice(index).toLowerCase();
}

export function isTypeScriptSemanticSource(filePath: string): boolean {
  return typeScriptExtensions.has(getExtension(filePath));
}

interface CollectSourceEvidenceOptions {
  cache?: Map<string, SourceEvidence>;
  cacheIdentity?: string;
  filePath: string;
  importAnalysis: ImportAnalysisContext;
  packageRootDir: string;
  semanticFamily?: 'astro' | 'svelte' | 'typescript' | 'vue';
  sourceProfile?: VueSourceProfile;
}

function createSourceEvidenceCacheKey(
  options: CollectSourceEvidenceOptions,
): string | undefined {
  if (options.cacheIdentity === undefined) return undefined;
  return JSON.stringify({
    filePath: options.filePath,
    project: options.cacheIdentity,
    semanticFamily: normalizeCacheValue(options.semanticFamily),
    sourceProfile: normalizeCacheValue(options.sourceProfile),
  });
}

function normalizeCacheValue<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

function getCachedSourceEvidence(options: {
  cache?: Map<string, SourceEvidence>;
  cacheKey: string | undefined;
}): SourceEvidence | undefined {
  if (options.cacheKey === undefined) return undefined;
  const cached = readCachedSourceEvidence(options.cache, options.cacheKey);
  return cached === undefined ? undefined : cloneSourceEvidence(cached);
}

function readCachedSourceEvidence(
  cache: Map<string, SourceEvidence> | undefined,
  cacheKey: string,
): SourceEvidence | undefined {
  if (cache === undefined) return undefined;
  return cache.get(cacheKey);
}

function storeSourceEvidence(options: {
  cache?: Map<string, SourceEvidence>;
  cacheKey: string | undefined;
  evidence: SourceEvidence;
}): SourceEvidence {
  if (options.cacheKey !== undefined) {
    options.cache?.set(options.cacheKey, cloneSourceEvidence(options.evidence));
  }
  return options.evidence;
}

function collectTypeScriptRecords(
  options: CollectSourceEvidenceOptions,
): SourceEvidence['records'] {
  return collectTypeScriptSourceTextImports({
    filePath: options.filePath,
    sourceText: readFileSync(options.filePath, 'utf8'),
  });
}

function collectRecords(
  options: CollectSourceEvidenceOptions,
): SourceEvidence['records'] {
  if (isTypeScriptSemanticSource(options.filePath)) {
    return collectTypeScriptRecords(options);
  }
  return options.importAnalysis.collectImportsFromFile(
    options.filePath,
    options.packageRootDir,
    options.sourceProfile,
  );
}

function createFailureEvidence(
  filePath: string,
  error: unknown,
): SourceEvidence {
  return {
    diagnostics: [error instanceof Error ? error.message : String(error)],
    filePath,
    records: [],
  };
}

export function collectSourceEvidence(
  options: CollectSourceEvidenceOptions,
): SourceEvidence {
  const cacheKey = createSourceEvidenceCacheKey(options);
  const cached = getCachedSourceEvidence({ cache: options.cache, cacheKey });
  if (cached !== undefined) return cached;
  try {
    return storeSourceEvidence({
      cache: options.cache,
      cacheKey,
      evidence: {
        diagnostics: [],
        filePath: options.filePath,
        records: collectRecords(options),
      },
    });
  } catch (error) {
    return storeSourceEvidence({
      cache: options.cache,
      cacheKey,
      evidence: createFailureEvidence(options.filePath, error),
    });
  }
}
