import type ts from 'typescript';

export const SVELTE_SEMANTIC_ADAPTER_VERSION =
  'svelte2tsx-0.7.61-v2-occurrence-mode';

export interface SvelteSemanticProject {
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
