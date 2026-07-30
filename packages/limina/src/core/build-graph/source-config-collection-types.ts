import type { CheckerProjectConfigCache } from '#checkers';
import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type { CheckerSourceConfigCollection } from './types';

export interface CollectionContext {
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: string;
  checkerPreset: ResolvedCheckerConfig['preset'];
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaConfig;
  problems: string[];
  projectConfigCache?: CheckerProjectConfigCache;
  seenConfigs: Set<string>;
}

export interface ConfigVisit extends CollectionContext {
  referencedFromConfigPath?: string;
  sourceConfigPath: string;
}

export interface CollectCheckerSourceConfigsOptions {
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: string;
  checkerPreset: ResolvedCheckerConfig['preset'];
  config: ResolvedLiminaConfig;
  entryConfigPaths: readonly string[];
  projectConfigCache?: CheckerProjectConfigCache;
}

export interface CollectAutoSourceConfigModulesOptions {
  activatedRegions: WorkspaceRegionPathIndex;
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaConfig;
  entryConfigPath: string;
  problems: string[];
  projectConfigCache?: CheckerProjectConfigCache;
}
