import type { VueSourceProfile } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ImportRecord } from './records';
import type {
  CreateImportAnalysisContextOptions,
  ImportAnalysisCaches,
  ImportAnalysisMetricsRecorder,
} from './types';
import { collectTypeScriptSourceTextImports } from './typescript-imports';

interface SourceProvider {
  collectImportsFromFile(
    filePath: string,
    rootDir: string,
    sourceProfile?: VueSourceProfile,
  ): ImportRecord[];
}

const FRAMEWORK_EXTENSIONS = new Set(['.astro', '.svelte', '.vue']);

export const FRAMEWORK_CONTEXT_REQUIRED_MESSAGE =
  'Framework source requires project/checker context; use getResolvedImports(file, project).';

function assertStandaloneSource(options: {
  filePath: string;
  sourceProfile?: VueSourceProfile;
}): void {
  if (
    options.sourceProfile !== undefined ||
    FRAMEWORK_EXTENSIONS.has(path.extname(options.filePath).toLowerCase())
  ) {
    throw new Error(FRAMEWORK_CONTEXT_REQUIRED_MESSAGE);
  }
}

function recordCacheAccess(options: {
  hit: boolean;
  kind: 'imports' | 'source-text';
  metrics: ImportAnalysisMetricsRecorder | undefined;
}): void {
  options.metrics?.record({
    kind: options.kind,
    name: options.hit ? 'provider-cache-hit' : 'provider-cache-miss',
    provider: 'import-core',
  });
}

function recordSourceOperation(options: {
  filePath: string;
  metrics: ImportAnalysisMetricsRecorder | undefined;
  name: 'source-parse' | 'source-read';
}): void {
  options.metrics?.record({
    kind: path.extname(options.filePath) || 'extensionless',
    name: options.name,
    provider: 'import-core',
  });
}

function createSourceTextReader(options: {
  caches: ImportAnalysisCaches;
  metrics: ImportAnalysisMetricsRecorder | undefined;
}): (filePath: string) => string {
  return (filePath) => {
    const cached = options.caches.sourceTextCache.get(filePath);
    recordCacheAccess({
      hit: cached !== undefined,
      kind: 'source-text',
      metrics: options.metrics,
    });
    if (cached !== undefined) return cached;
    const sourceText = readFileSync(filePath, 'utf8');
    recordSourceOperation({
      filePath,
      metrics: options.metrics,
      name: 'source-read',
    });
    options.caches.sourceTextCache.set(filePath, sourceText);
    return sourceText;
  };
}

export function createSourceProvider(options: {
  caches: ImportAnalysisCaches;
  contextOptions: CreateImportAnalysisContextOptions;
}): SourceProvider {
  const metrics = options.contextOptions.metrics;
  const readSourceText = createSourceTextReader({
    caches: options.caches,
    metrics,
  });

  function collect(
    filePath: string,
    rootDir: string,
    sourceProfile?: VueSourceProfile,
  ): ImportRecord[] {
    const normalizedFilePath = normalizeAbsolutePath(filePath);
    assertStandaloneSource({ filePath: normalizedFilePath, sourceProfile });
    const cacheKey = JSON.stringify({
      filePath: normalizedFilePath,
      packageRootDir: normalizeAbsolutePath(rootDir),
      parser: 'typescript-ast-v1',
    });
    const cached = options.caches.importsCache.get(cacheKey);
    recordCacheAccess({
      hit: cached !== undefined,
      kind: 'imports',
      metrics,
    });
    if (cached !== undefined) return cached;
    const imports = collectTypeScriptSourceTextImports({
      filePath: normalizedFilePath,
      sourceText: readSourceText(normalizedFilePath),
    });
    recordSourceOperation({
      filePath: normalizedFilePath,
      metrics,
      name: 'source-parse',
    });
    options.caches.importsCache.set(cacheKey, imports);
    return imports;
  }

  return {
    collectImportsFromFile: collect,
  };
}
