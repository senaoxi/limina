import type { ResolvedGovernanceRoot } from '#utils/workspace-root';
import type { ExecutionConfig } from '../execution/config';
import type { GraphConfig, ProofConfig } from './graph-proof-types';
import type { PackageConfig } from './package-types';
import type { PipelineStep } from './pipeline-checker-types';
import type { ReleaseConfig } from './release-types';
import type { SharedLiminaConfig, SourceCheckConfig } from './source-types';

export type RegionExcludeKind =
  | 'package-scope'
  | 'workspace-package'
  | 'tsconfig';

export interface RegionExcludeConfig {
  include: string[];
  kind: RegionExcludeKind;
  reason: string;
}

export interface RegionsConfig {
  exclude?: RegionExcludeConfig[];
  extendNestedPackageScopes?: boolean;
}

export interface CacheOptions {
  /**
  Exact file inputs outside module loading, relative to the config file.
  */
  dependencies: string[];
}

export interface LiminaConfig {
  config?: SharedLiminaConfig;
  /**
  Persistent analysis caching defaults to enabled; checker caches are separate.
  */
  cache?: boolean | CacheOptions;
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

export interface LiminaConfigEnvironment {
  command: LiminaCommand;
  mode: string;
}

export type LiminaConfigFunctionObject = (
  environment: LiminaConfigEnvironment,
) => LiminaConfig;
export type LiminaConfigFunctionPromise = (
  environment: LiminaConfigEnvironment,
) => Promise<LiminaConfig>;
export type LiminaConfigFunction = (
  environment: LiminaConfigEnvironment,
) => LiminaConfig | Promise<LiminaConfig>;

export type LiminaConfigExport =
  | LiminaConfig
  | Promise<LiminaConfig>
  | LiminaConfigFunctionObject
  | LiminaConfigFunctionPromise
  | LiminaConfigFunction;

export interface ResolvedLiminaConfig extends LiminaConfig {
  /**
  Internal, generation-local config input. Never serialized as user configuration.
  */
  virtualFiles?: ReadonlyMap<string, string>;
  configPath: string;
  governanceRoot: ResolvedGovernanceRoot;
  /**
  Compatibility projection of governanceRoot.rootDir.
  */
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
