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
  seenConfigs: Set<string>;
}

export interface ConfigVisit extends CollectionContext {
  referencedFromConfigPath?: string;
  sourceConfigPath: string;
}
