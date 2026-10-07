import { createAmbientTypeEvidence } from '../type-evidence/ambient-symbol';
import type { TypeEvidenceGenerationCache } from '../type-evidence/cache';
const nativeProviders = new WeakSet<typeof createAmbientTypeEvidence>();
export function memoizedNativeAmbientEvidence(
  cache: TypeEvidenceGenerationCache,
): typeof createAmbientTypeEvidence {
  const provider: typeof createAmbientTypeEvidence = (symbol, tsModule) =>
    cache.getOrCreateAmbientSymbolEvidence(symbol, () =>
      createAmbientTypeEvidence(symbol, tsModule),
    );
  nativeProviders.add(provider);
  return provider;
}
export function isNativeAmbientEvidence(
  provider: typeof createAmbientTypeEvidence | undefined,
): boolean {
  return [
    provider === undefined,
    provider === createAmbientTypeEvidence,
    provider !== undefined && nativeProviders.has(provider),
  ].some(Boolean);
}
