import type { ResolvedLiminaConfig } from '#config/runner';
import type {
  ImportAnalysisContext,
  ProjectInfo,
} from '#core/import-graph/context';
import type { WorkspacePackage } from '#core/workspace/actions';
import type { WorkspaceExportsResolutionIndex } from '../core/workspace/exports';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { DependencyGraphEdge, DependencyGraphView } from './types';

export interface DependencyGraphCollectionContext {
  config: ResolvedLiminaConfig;
  edgesByKey: Map<string, DependencyGraphEdge>;
  fileOwnerLookup: Map<string, string[]>;
  importAnalysis: ImportAnalysisContext;
  problems: string[];
  projects: ProjectInfo[];
  view: DependencyGraphView;
  workspaceExports: WorkspaceExportsResolutionIndex;
  workspaceLookup: WorkspaceLookupIndex;
  workspacePackages: WorkspacePackage[];
}
