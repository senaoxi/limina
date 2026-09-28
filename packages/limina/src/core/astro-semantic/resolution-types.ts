import type {
  AstroSemanticProject,
  ResolvedCheckerModuleName,
} from '#checkers';
import type { ImportRecord } from '#core/import-analysis/runner';
import type {
  FrameworkSemanticEvidence,
  FrameworkSemanticFailureStage,
} from '../framework-semantic/contracts';
import type { ImportAnalysisMetricsRecorder } from '../import-analysis/types';
import type { AstroSemanticContextManager } from './context';

export type AstroSemanticResolution =
  | {
      evidence: FrameworkSemanticEvidence;
      kind: 'resolved';
      resolution: ResolvedCheckerModuleName | null;
    }
  | {
      kind: 'unsupported';
      reason: string;
      scopeIdentity?: string;
      stage: FrameworkSemanticFailureStage;
    };

export interface ResolveAstroSemanticImportOptions {
  importRecord: ImportRecord;
  manager: AstroSemanticContextManager;
  metrics?: ImportAnalysisMetricsRecorder;
  project: AstroSemanticProject;
}
