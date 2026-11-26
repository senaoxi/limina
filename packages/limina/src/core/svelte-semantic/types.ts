import type ts from 'typescript';
import type { CheckerConfigClosureEntry } from '../../checker/types';

export const SVELTE_SEMANTIC_ADAPTER_VERSION =
  'svelte2tsx-0.7.61-v5-check-view';

export interface SvelteSourceConfig {
  configClosure: readonly CheckerConfigClosureEntry[];
  options: ts.CompilerOptions;
  references: readonly ts.ProjectReference[];
  svelteOptions: unknown;
}

export interface SvelteSemanticProject {
  readSourceConfig?: (tsModule: typeof ts) => SvelteSourceConfig;
  virtualFiles?: ReadonlyMap<string, string>;
  references?: readonly ts.ProjectReference[];
  svelteOptions?: { namespace?: string };
  adapterVersion: typeof SVELTE_SEMANTIC_ADAPTER_VERSION;
  configClosure?: readonly { filePath: string; contentHash: string }[];
  packageIdentity?: string;
  configPath: string;
  extensions: readonly string[];
  fileNames: readonly string[];
  generation: number;
  options: ts.CompilerOptions;
  packageRootDir: string;
  resolverConfigPath: string;
}
