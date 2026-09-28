import type { CheckerProjectConfigCache } from '#checkers';
import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import type { JsonObject } from '#core/tsconfig/actions';
import type ts from 'typescript';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type { CheckerSourceConfigCollection } from './types';

export interface CollectionContext {
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: ResolvedCheckerConfig['name'];
  checkerPreset: ResolvedCheckerConfig['name'];
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaConfig;
  discoveryExtensions?: string[];
  explicitOwnerByConfigPath?: ReadonlyMap<
    string,
    ResolvedCheckerConfig['name']
  >;
  inheritedOwnerByConfigPath?: Map<string, ResolvedCheckerConfig['name']>;
  problems: string[];
  projectConfigCache?: CheckerProjectConfigCache;
  seenConfigs: Set<string>;
  sourceConfigInspector?: SourceConfigInspector;
}

export type SourceConfigInspector = (options: {
  configObject: JsonObject;
  sourceConfigPath: string;
}) => void;

export interface ConfigVisit extends CollectionContext {
  referencedFromConfigPath?: string;
  sourceConfigPath: string;
}

export interface SourceConfigAnalysis {
  configObject: JsonObject;
  fileNames: string[];
  options: ts.CompilerOptions;
}

export interface CollectCheckerSourceConfigsOptions {
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: ResolvedCheckerConfig['name'];
  checkerPreset: ResolvedCheckerConfig['name'];
  config: ResolvedLiminaConfig;
  discoveryExtensions?: string[];
  entryConfigPaths: readonly string[];
  explicitOwnerByConfigPath?: ReadonlyMap<
    string,
    ResolvedCheckerConfig['name']
  >;
  inheritedOwnerByConfigPath?: Map<string, ResolvedCheckerConfig['name']>;
  projectConfigCache?: CheckerProjectConfigCache;
}

export interface CollectAutoSourceConfigModulesOptions {
  activatedRegions: WorkspaceRegionPathIndex;
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaConfig;
  discoveryExtensions: string[];
  entryConfigPath: string;
  problems: string[];
  projectConfigCache?: CheckerProjectConfigCache;
  sourceConfigInspector: SourceConfigInspector;
}
