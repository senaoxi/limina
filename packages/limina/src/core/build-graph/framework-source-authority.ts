import {
  resolveAstroSemanticToolchain,
  type VueSemanticToolchain,
} from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { createRequire } from 'node:module';
import { canReuseConfigProjection } from '../../checker/project-base';
import { isVueCacheTuple } from '../../checker/vue-semantic-compatibility';
import { AnalysisInputDriftError } from '../analysis-cache/contracts';
import { analysisHash } from '../analysis-cache/identity';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { QueryTrace } from '../analysis-cache/query-trace';
import {
  observeVueToolFile,
  observeVueTools,
} from '../analysis-cache/vue-toolchain-inputs';
import { resolveSvelteSemanticToolchain } from '../svelte-semantic/toolchain';
import { SVELTE_SEMANTIC_ADAPTER_VERSION } from '../svelte-semantic/types';
import { nativeHostContract } from '../typescript-semantic/compiler-path-key';
import type { LockedSemanticAuthority } from './checker-ownership-types';
import type { FrozenSemanticProject } from './locked-semantic-project';
import { partitionSourceFiles } from './source-capabilities';

function vueConfigProviderBinding(
  cache: NativeAnalysisCache,
  toolchain: VueSemanticToolchain,
  key: string,
): string | undefined {
  if (
    !isVueCacheTuple(toolchain.versions) ||
    !canReuseConfigProjection(toolchain.tsModule)
  )
    return undefined;
  return cache.inputs.memoizeObservation(`vue-config-provider:${key}`, () => {
    let binding: string | undefined;
    try {
      const resolver = createRequire(toolchain.paths.vueTsc);
      const entry = resolver.resolve('vue-tsc');
      const trace = new QueryTrace(cache.inputs);
      observeVueToolFile(entry, trace);
      observeVueTools({ toolchain }, trace);
      const dependencies = trace.dependencies
        .values()
        .toArray()
        .sort((left, right) => compareCodeUnits(left.inputId, right.inputId));
      cache.inputs.consume(dependencies);
      binding = analysisHash([key, dependencies]);
    } catch (error) {
      if (error instanceof AnalysisInputDriftError) throw error;
      // A runnable checker may expose only its binary. Missing implementation
      // evidence leaves its current configuration parse authoritative.
    }
    return binding;
  });
}

export function bindVueSourceConfig(
  cache: NativeAnalysisCache,
  configPath: string,
  source: LockedSemanticAuthority['source'],
  toolchain: VueSemanticToolchain,
): string | undefined {
  const key = analysisHash([
    toolchain.adapter,
    toolchain.paths,
    toolchain.versions,
  ]);
  const binding = vueConfigProviderBinding(cache, toolchain, key);
  cache.recordSourceConfigAuthority({
    configPath,
    family: 'vue',
    source,
    provider: 'vue',
    toolchain: binding ?? key,
  });
  return binding;
}

export function recordFrameworkSourceAuthority(input: {
  cache?: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  frozen: FrozenSemanticProject;
}): void {
  if (input.cache === undefined) return;
  const { authority, project } = input.frozen;
  const { family, source } = authority;
  if (family === 'typescript' || family === 'vue') return;
  const configPath = project.configPath;
  const binding = frameworkAuthorityBinding(input.frozen, input.config);
  if (binding === undefined) {
    input.cache.invalidateSourceConfig(configPath);
    return;
  }
  input.cache.recordSourceConfigAuthority({
    configPath,
    family,
    source,
    ...binding,
  });
}

function frameworkAuthorityBinding(
  { authority, project }: FrozenSemanticProject,
  config: ResolvedLiminaInputs,
): { provider: string; toolchain: string } | undefined {
  const partition = partitionSourceFiles(project.fileNames);
  const root = project.packageRootDir;
  const native = nativeHostContract();
  try {
    if (
      authority.family === 'astro' &&
      partition.astroFiles.length +
        partition.svelteFiles.length +
        partition.vueFiles.length >
        0
    ) {
      const manifest =
        root === config.governanceRoot?.rootDir
          ? config.governanceRoot.manifest
          : undefined;
      const { paths, versions, adapter } = resolveAstroSemanticToolchain(
        root,
        manifest,
      );
      return {
        provider: 'astro',
        toolchain: analysisHash([native, adapter, paths, versions]),
      };
    }
    if (authority.family === 'svelte' && partition.svelteFiles.length > 0) {
      const {
        compilerPath,
        compilerVersion,
        transformPath,
        transformVersion,
        typeScriptPath,
        typeScriptVersion,
      } = resolveSvelteSemanticToolchain(root);
      return {
        provider: 'svelte',
        toolchain: analysisHash([
          native,
          SVELTE_SEMANTIC_ADAPTER_VERSION,
          compilerPath,
          compilerVersion,
          transformPath,
          transformVersion,
          typeScriptPath,
          typeScriptVersion,
        ]),
      };
    }
    return { provider: 'native-typescript', toolchain: native };
  } catch {
    // The semantic preparation path diagnoses unavailable installations.
    return undefined;
  }
}
