import type { ExecutionConfig } from '../execution/config';
import type { GraphConfig, ProofConfig } from './graph-proof-types';
import type { PackageConfig } from './package-types';
import type { PipelineStep } from './pipeline-checker-types';
import type { ReleaseConfig } from './release-types';
import type { SharedLiminaConfig, SourceCheckConfig } from './source-types';

export type RegionExcludeKind = 'package-scope' | 'workspace-package';

export interface RegionExcludeConfig {
  include: string[];
  kind: RegionExcludeKind;
  reason: string;
}

export interface RegionsConfig {
  exclude?: RegionExcludeConfig[];
  extendNestedPackageScopes?: boolean;
}

export interface LiminaConfig {
  config?: SharedLiminaConfig;
  execution?: ExecutionConfig;
  graph?: GraphConfig;
  package?: PackageConfig;
  pipelines?: Record<string, PipelineStep[]>;
  proof?: ProofConfig;
  regions?: RegionsConfig;
  release?: ReleaseConfig;
  source?: SourceCheckConfig;
}

export type LiminaCommand =
  | 'check'
  | 'graph'
  | 'package'
  | 'proof'
  | 'release'
  | 'source'
  | (string & {});

export interface LiminaConfigEnv {
  command: LiminaCommand;
  mode: string;
}

export type LiminaConfigFnObject = (env: LiminaConfigEnv) => LiminaConfig;
export type LiminaConfigFnPromise = (
  env: LiminaConfigEnv,
) => Promise<LiminaConfig>;
export type LiminaConfigFn = (
  env: LiminaConfigEnv,
) => LiminaConfig | Promise<LiminaConfig>;

export type LiminaConfigExport =
  | LiminaConfig
  | Promise<LiminaConfig>
  | LiminaConfigFnObject
  | LiminaConfigFnPromise
  | LiminaConfigFn;

export interface ResolvedLiminaConfig extends LiminaConfig {
  configPath: string;
  rootDir: string;
}

export type LiminaConfigLoader = 'native' | 'tsx';

export interface LoadConfigOptions {
  command?: LiminaCommand;
  configLoader?: LiminaConfigLoader;
  configPath?: string;
  cwd?: string;
  mode?: string;
}
