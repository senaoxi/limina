import type { ResolvedLiminaInputs } from '#config/runner';
import type {
  ImportAnalysisContext,
  ImportRecord,
  ResolvedCheckerModuleName,
} from '#core/import-analysis/runner';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import type { ReferenceDependency } from '../project-dependencies/reference-facts';
import type { WorkspaceSourceBoundary } from '../typescript-semantic';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type { FileOwnerLookup } from './file-owner-lookup';
import type { SvelteConsumerView } from './svelte-consumer-view';
import type {
  DependencyAnalysisResult,
  GeneratedDependencyEdge,
  SourceProject,
} from './types';

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
  svelteConsumerView?: SvelteConsumerView;
  analysis?: DependencyAnalysisResult;
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaInputs;
  dtsProjectsBySourcePath: Map<string, SourceProject[]>;
  fileOwnerLookup: FileOwnerLookup;
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
  projectDependency: ReferenceDependency;
  project: SourceProject;
}

export interface ReferenceTarget {
  providerSourceFilePaths: readonly string[];
  resolvedFilePath: string;
  targetSourceConfigPath: string;
}
