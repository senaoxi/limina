import { currentProfile } from '../../application/analysis/observability';
import { observeWork } from '../analysis-profile';
import { isSvelteTypeScriptSource } from './source-records';
import type { SvelteSemanticToolchain } from './toolchain';

type GeneratedOutput = Pick<
  ReturnType<SvelteSemanticToolchain['transform']>,
  'code' | 'map'
>;

interface CachedTransform {
  sourceText: string;
  namespace?: string;
  compiler: SvelteSemanticToolchain['compiler'];
  parse: SvelteSemanticToolchain['compiler']['parse'];
  version: string;
  transform: SvelteSemanticToolchain['transform'];
  output: GeneratedOutput;
}

export type SvelteTransformCache = Map<string, CachedTransform>;

export function transformSvelteComponent(
  filename: string,
  sourceText: string,
  namespace: string | undefined,
  toolchain: SvelteSemanticToolchain,
  cache?: SvelteTransformCache,
): GeneratedOutput {
  const { compiler, compilerVersion: version, transform } = toolchain;
  const { parse } = compiler;
  const cached = cache?.get(filename);
  if (
    cached?.sourceText === sourceText &&
    cached.namespace === namespace &&
    cached.compiler === compiler &&
    cached.parse === parse &&
    cached.version === version &&
    cached.transform === transform
  )
    return cached.output;

  const { code, map } = observeWork(currentProfile(), 'svelte-transform', () =>
    transform(sourceText, {
      filename,
      isTsFile: isSvelteTypeScriptSource(sourceText),
      namespace,
      parse: parse as never,
      version,
    }),
  );
  const output = { code, map };
  cache?.set(filename, {
    sourceText,
    namespace,
    compiler,
    parse,
    version,
    transform,
    output,
  });
  return output;
}
