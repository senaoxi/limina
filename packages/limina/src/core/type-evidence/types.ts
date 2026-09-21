import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import type { ImportRuntimeResolutionEvidence } from '../import-analysis/evidence';
import type {
  TypeScriptSemanticProject,
  WorkspaceSourceBoundary,
} from '../typescript-semantic';
import type { SourceSyntaxFactsCache } from '../typescript-semantic/syntax-cache';
import type { VueSemanticContextManager } from '../vue-semantic/context';
import type { TypeEvidenceMetricsRecorder } from './cache';
import type { ResolveImportEvidenceOptions } from './resolution';

export type WorkspaceBoundedImportEvidenceOptions = Omit<
  ResolveImportEvidenceOptions,
  'project'
> & {
  project: ResolveImportEvidenceOptions['project'] &
    Pick<TypeScriptSemanticProject, 'workspaceSourceBoundary'>;
};

export interface TypeEvidenceCoreOptions {
  syntaxFacts?: SourceSyntaxFactsCache;
  generation: number;
  importAnalysis: ImportAnalysisContext;
  metrics?: TypeEvidenceMetricsRecorder;
  vueSemanticContexts?: VueSemanticContextManager;
  workspaceSourceBoundaryProvider(
    project: ResolveImportEvidenceOptions['project'],
  ): WorkspaceSourceBoundary;
}

export interface ProviderEvidenceInput {
  options: WorkspaceBoundedImportEvidenceOptions;
  preset: string;
  runtimeEvidence: ImportRuntimeResolutionEvidence;
}
