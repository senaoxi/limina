import type { ResolvedLiminaConfig } from '#config/runner';
import type {
  ImportAnalysisContext,
  ImportRecord,
} from '#core/import-analysis/runner';
import type { DeclarationProviderResolution } from '../import-graph/declaration-provider';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type { GeneratedProviderEdge, SourceProject } from './types';

export type ResolvedProvider = Extract<
  DeclarationProviderResolution,
  { kind: 'declaration' | 'source' }
>;

export interface ReferenceImportContext {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  dtsProjectsBySourcePath: Map<string, SourceProject[]>;
  fileOwnerLookup: Map<string, string[]>;
  importAnalysis: ImportAnalysisContext;
  managedOutputLookup: ManagedOutputDeclarationLookup;
  problems: string[];
  providerEdgesByKey: Map<string, GeneratedProviderEdge>;
}

export interface ReferenceImportOptions {
  context: ReferenceImportContext;
  fileName: string;
  importRecord: ImportRecord;
  project: SourceProject;
}

export interface ReferenceTarget {
  providerSourceFilePath: string;
  resolvedFilePath: string;
  targetSourceConfigPath: string;
}
