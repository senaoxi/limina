import type {
  CheckerProjectConfigCache,
  ParsedCheckerProjectConfig,
} from '#checkers';
import type {
  ResolvedCheckerConfig,
  ResolvedLiminaInputs,
} from '#config/runner';
import type { JsonObject } from '#core/tsconfig/actions';
import type ts from 'typescript';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type { SourceConfigDiscovery } from './source-config-discovery';
import type { CheckerSourceConfigCollection } from './types';

export interface CollectionContext {
  onInputError?: (configPath: string, error: Error) => void;
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: ResolvedCheckerConfig['name'];
  checkerPreset: ResolvedCheckerConfig['name'];
  collection: CheckerSourceConfigCollection;
  config: ResolvedLiminaInputs;
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
  configClosure: ParsedCheckerProjectConfig['configClosure'];
  configObject: JsonObject;
  fileNames: string[];
  options: ts.CompilerOptions;
}

export interface CollectCheckerSourceConfigsOptions {
  onProblems?: (problems: string[]) => void;
  sourceDiscovery?: SourceConfigDiscovery;
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: ResolvedCheckerConfig['name'];
  checkerPreset: ResolvedCheckerConfig['name'];
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
  discoveryExtensions: string[];
  entryConfigPath: string;
  problems: string[];
  projectConfigCache?: CheckerProjectConfigCache;
  sourceConfigInspector: SourceConfigInspector;
}
