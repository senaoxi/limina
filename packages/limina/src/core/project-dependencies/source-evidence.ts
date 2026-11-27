import type { VueSourceProfile } from '#checkers';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import {
  collectTypeScriptSourceTextImports,
  readTypeScriptSourceText,
} from '../import-analysis/typescript-imports';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { TypeScriptSemanticDependencyContext } from '../typescript-semantic/contracts';
import { cloneSourceEvidence } from './cache';
import type { ProjectDependencyCaches, SourceEvidence } from './contracts';

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

export function isNativeProjectDependencyTarget(file: string): boolean {
  return isTypeScriptSemanticSource(file) || isDeclarationFile(file);
}

interface CollectSourceEvidenceOptions {
  caches?: ProjectDependencyCaches;
  cacheIdentity?: string;
  filePath: string;
  generation: number;
  importAnalysis: ImportAnalysisContext;
  packageRootDir: string;
  semanticFamily?: 'astro' | 'svelte' | 'typescript' | 'vue';
  sourceProfile?: VueSourceProfile;
  typeScriptSemanticContext?: TypeScriptSemanticDependencyContext;
  virtualSourceText?: string;
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
  return cache === undefined ? undefined : cache.get(cacheKey);
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
  const { caches, filePath, generation, virtualSourceText } = options;
  if (options.sourceProfile !== undefined)
    return parseSourceText(
      options,
      virtualSourceText ?? readTypeScriptSourceText(filePath),
    );
  const contextFacts =
    options.typeScriptSemanticContext?.getFileDependencyFacts?.(filePath);
  if (contextFacts !== undefined) {
    return contextFacts.requests
      .filter((request) => !request.externalModuleOnly)
      .map((request) => request.occurrence);
  }
  if (virtualSourceText !== undefined)
    return parseSourceText(options, virtualSourceText);
  const qualified = caches?.analysisCache?.readSourceSyntax(filePath);
  if (qualified !== undefined) return qualified;

  const sourceText = readTypeScriptSourceText(filePath);
  const cached = caches?.physicalSourceSyntax.get(filePath);
  if (cached?.generation === generation && cached.sourceText === sourceText)
    return structuredClone(cached.records);

  const records = parseSourceText(options, sourceText);
  caches?.physicalSourceSyntax.set(filePath, {
    generation,
    sourceText,
    records: structuredClone(records),
  });
  return records;
}

function parseSourceText(
  options: CollectSourceEvidenceOptions,
  sourceText: string,
): SourceEvidence['records'] {
  options.caches?.analysisCache?.increment('sourceSyntaxParses');
  return collectTypeScriptSourceTextImports({
    filePath: options.filePath,
    sourceText,
  });
}

function collectRecords(
  options: CollectSourceEvidenceOptions,
): SourceEvidence['records'] {
  return isTypeScriptSemanticSource(options.filePath)
    ? collectTypeScriptRecords(options)
    : options.importAnalysis.collectImportsFromFile(
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
  const cache = options.caches?.sourceEvidenceCache;
  const cached = getCachedSourceEvidence({ cache, cacheKey });
  if (cached !== undefined) return cached;
  try {
    return storeSourceEvidence({
      cache,
      cacheKey,
      evidence: {
        diagnostics: [],
        filePath: options.filePath,
        records: collectRecords(options),
      },
    });
  } catch (error) {
    return storeSourceEvidence({
      cache,
      cacheKey,
      evidence: createFailureEvidence(options.filePath, error),
    });
  }
}
