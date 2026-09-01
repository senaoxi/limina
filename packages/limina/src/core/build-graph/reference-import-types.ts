import type { ResolvedLiminaConfig } from '#config/runner';
import type {
  ImportAnalysisContext,
  ImportRecord,
  ResolvedCheckerModuleName,
} from '#core/import-analysis/runner';
import type {
  ProjectDependency,
  ProjectDependencyCaches,
} from '../project-dependencies/contracts';
import type { WorkspaceSourceBoundary } from '../typescript-semantic';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type { GeneratedDependencyEdge, SourceProject } from './types';

export type ResolvedProvider =
  | {
      kind: 'declaration';
      oxcResolvedFilePath: null;
      typeScriptResolution: ResolvedCheckerModuleName;
    }
  | {
      kind: 'source';
      ownerProjectPaths: string[];
      oxcResolvedFilePath: null;
      typeScriptResolution: ResolvedCheckerModuleName;
    };

export interface ReferenceImportContext {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  dtsProjectsBySourcePath: Map<string, SourceProject[]>;
  fileOwnerLookup: Map<string, string[]>;
  importAnalysis: ImportAnalysisContext;
  projectDependencyCaches: ProjectDependencyCaches;
  problems: string[];
  dependencyEdgesByKey: Map<string, GeneratedDependencyEdge>;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}

export interface ReferenceImportOptions {
  context: ReferenceImportContext;
  fileName: string;
  importRecord: ImportRecord;
  projectDependency: ProjectDependency;
  project: SourceProject;
}

export interface ReferenceTarget {
  providerSourceFilePath: string;
  resolvedFilePath: string;
  targetSourceConfigPath: string;
}
