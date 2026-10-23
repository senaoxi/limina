import type { ResolvedGovernanceRoot } from '#utils/workspace-root';
import type { ExecutionConfig } from '../execution/config';
import type { GraphConfig, ProofConfig } from './graph-proof-types';
import type { PackageConfig } from './package-types';
import type { CheckerConfigMode, PipelineStep } from './pipeline-checker-types';
import type { ReleaseConfig } from './release-types';
import type { SourceBoundaryConfig, SourceCheckConfig } from './source-types';

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

export interface ScopeConfig {
  regions?: RegionsConfig;
  source?: SourceBoundaryConfig;
  checkers?: CheckerConfigMode;
}

export interface LiminaConfig {
  scope?: ScopeConfig;
  /**
  Configuring this domain enables graph:check in the default workflow.
  */
  graph?: GraphConfig;
  /**
  Enables source:check, independently of the Knip sub-capability.
  */
  source?: SourceCheckConfig;
  /**
  Enables proof:check; allowlist: [] grants no coverage exceptions.
  */
  proof?: ProofConfig;
  package?: PackageConfig;
  release?: ReleaseConfig;
  pipelines?: Record<string, PipelineStep[]>;
  concurrency?: ExecutionConfig;
  /**
  Persistent analysis caching defaults to enabled; checker caches are separate.
  */
  cache?: boolean | CacheOptions;
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

/**
Input readers can also consume defaults without a loaded module.
*/
export interface ResolvedLiminaInputs extends LiminaConfig {
  /**
  Internal, generation-local config input. Never serialized as user configuration.
  */
  virtualFiles?: ReadonlyMap<string, string>;
  configPath?: string;
  governanceRoot: ResolvedGovernanceRoot;
  /**
  Compatibility projection of governanceRoot.rootDir.
  */
  rootDir: string;
}

export interface ResolvedLiminaConfig extends ResolvedLiminaInputs {
  configPath: string;
}

export type LiminaConfigLoader = 'native' | 'tsx';

export interface LoadConfigOptions {
  command?: LiminaCommand;
  configLoader?: LiminaConfigLoader;
  configPath?: string;
  cwd?: string;
  mode?: string;
}
