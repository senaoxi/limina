import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type ts from 'typescript';
import { analysisHash } from '../analysis-cache/identity';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import { observedResolutionHost } from '../typescript-semantic/observed-resolution-host';

export interface EffectiveTypeInput {
  name: string;
  target: string | null;
}

export function collectConfigTypeInputs(input: {
  compiler: typeof ts;
  configPath: string;
  options: ts.CompilerOptions;
  cache?: NativeAnalysisCache;
}): EffectiveTypeInput[] {
  const { compiler, configPath, options, cache } = input;
  if (options.types?.length === 0) return [];
  const file = normalizeAbsolutePath(configPath);
  const effective = effectiveCompilerOptions(options);
  const host = observedResolutionHost(compiler, file);
  const contextId = analysisHash(['config-type-directives', compiler.version]);
  const query = <T>(
    request: unknown,
    resolve: (host: ts.ModuleResolutionHost) => T,
  ): T =>
    cache === undefined
      ? resolve(host)
      : cache.query({
          contextId,
          file,
          identity: { options: effective, request },
          retain: true,
          host,
          resolve,
        });
  const names = query('names', (host) => ({
    names: compiler.getAutomaticTypeDirectiveNames(effective, host),
    // Enumeration observes the host directly; it has no resolver result.
    failedLookupLocations: [],
    affectingLocations: [],
  })).names;
  const containingFile = path.join(
    path.dirname(file),
    '__inferred type names__.ts',
  );
  return names.map((name) => {
    const result = query(['entry', name], (host) =>
      compiler.resolveTypeReferenceDirective(
        name,
        containingFile,
        effective,
        host,
      ),
    );
    const target = result.resolvedTypeReferenceDirective?.resolvedFileName;
    return {
      name,
      target: target === undefined ? null : normalizeAbsolutePath(target),
    };
  });
}
