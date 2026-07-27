import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import type { ImportRuntimeResolutionEvidence } from '../import-analysis/evidence';
import type { TypeEvidenceMetricsRecorder } from './cache';
import type { ResolveImportEvidenceOptions } from './resolution';

export interface TypeEvidenceCoreOptions {
  generation: number;
  importAnalysis: ImportAnalysisContext;
  metrics?: TypeEvidenceMetricsRecorder;
}

export interface ProviderEvidenceInput {
  options: ResolveImportEvidenceOptions;
  preset: string;
  runtimeEvidence: ImportRuntimeResolutionEvidence;
}
