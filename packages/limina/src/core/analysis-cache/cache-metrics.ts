import type { AnalysisCacheMetrics } from './contracts';
export function emptyMetrics(): AnalysisCacheMetrics {
  return {
    probes: 0,
    probeMs: 0,
    reads: 0,
    readMs: 0,
    hashes: 0,
    hashMs: 0,
    resolverCalls: 0,
    queryHits: 0,
    factQueries: 0,
    factHits: 0,
    fallbacks: 0,
    importerHits: 0,
    importerQueries: 0,
    compilerReads: 0,
    compilerReadMs: 0,
    projectionMs: 0,
    semanticQueryMs: 0,
    firstSemanticQueryMs: 0,
    semanticPrograms: 0,
  };
}
