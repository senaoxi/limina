import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import type {
  NativeEvidenceFailure,
  NativeEvidenceSnapshot,
} from '../../domain/analysis/native-evidence';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from '../typescript-semantic/contracts';
import { createNativeDependencyContext } from '../typescript-semantic/native-context-factory';
import { collectNativeEvidence } from '../typescript-semantic/native-evidence-collection';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import {
  nativeObservationFailureKind,
  observationErrorDetail,
} from '../typescript-semantic/native-observation-failure';
import { createWorkspaceSourceBoundary } from '../typescript-semantic/workspace-source-boundary';
import { discoverNativeSourceUniverse } from './native-source-universe';

/**
The raw baseline survives later governance/ownership failures. No diagnostics or
build decisions are produced here, and collection never enters a final Checker.
*/
export function collectNativeSourceEvidence(
  input: Parameters<typeof discoverNativeSourceUniverse>[0] & {
    analysisCache?: NativeAnalysisCache;
    metrics?: AnalysisMetricsRecorder;
    retainContext?: (
      config: string,
      context: TypeScriptSemanticDependencyContext,
    ) => void;
  },
): NativeEvidenceSnapshot {
  const universe = discoverNativeSourceUniverse(input);
  const snapshots: NativeEvidenceSnapshot[] = [];
  const failures: NativeEvidenceFailure[] = [...universe.failures];
  const boundary = createWorkspaceSourceBoundary(
    universe.projects.flatMap((project) => project.fileNames),
    undefined,
    universe.coverage,
  );
  for (const project of universe.projects) {
    try {
      const context = sourceContext(input, {
        ...project,
        admissionMode: 'coverage-bounded',
        compilationObligationScope: 'generated-declaration-project-v1',
        analysisBinding: { phase: 'pending', checker: 'tsc' },
        virtualFiles: input.config.virtualFiles,
        workspaceSourceBoundary: boundary,
      });
      snapshots.push(context.nativeEvidence!);
      retainSourceContext(input, project.configPath, context);
    } catch (error) {
      failures.push({
        id: nativeFingerprint([
          project.configPath,
          observationErrorDetail(error),
        ]),
        kind: nativeObservationFailureKind(error),
        detail: observationErrorDetail(error),
        evidenceIds: [project.configPath],
        affected: {
          kind: 'universe',
          universeId: universe.coverage.universe.id,
        },
      });
    }
  }
  return mergeSourceEvidence(snapshots, universe.coverage, failures);
}

function sourceContext(
  input: Pick<
    Parameters<typeof collectNativeSourceEvidence>[0],
    'analysisCache' | 'metrics'
  >,
  project: TypeScriptSemanticProject,
): TypeScriptSemanticDependencyContext {
  return (
    input.analysisCache?.restoreContext(project) ??
    createNativeDependencyContext(project, input.analysisCache, input.metrics)
  );
}

function mergeSourceEvidence(
  snapshots: readonly NativeEvidenceSnapshot[],
  coverage: ReturnType<typeof discoverNativeSourceUniverse>['coverage'],
  failures: readonly NativeEvidenceFailure[],
): NativeEvidenceSnapshot {
  const empty = collectNativeEvidence([]);
  const records = {
    contexts: snapshots.flatMap((snapshot) => snapshot.contexts),
    coverage: snapshots.flatMap((snapshot) => snapshot.coverage),
    requests: snapshots.flatMap((snapshot) => snapshot.requests),
    traversal: snapshots.flatMap((snapshot) => snapshot.traversal),
    resolutions: snapshots.flatMap((snapshot) => snapshot.resolutions),
    relations: snapshots.flatMap((snapshot) => snapshot.relations),
    obligations: snapshots.flatMap((snapshot) => snapshot.obligations),
    completeness: snapshots.flatMap((snapshot) => snapshot.completeness),
    failures: [
      ...failures,
      ...snapshots.flatMap((snapshot) => snapshot.failures),
    ],
  };
  return freezeNativeData({
    ...empty,
    ...records,
    coverageIndexes: [coverage],
    run: records.failures.length === 0 ? 'completed' : 'unavailable',
  });
}

function retainSourceContext(
  input: Parameters<typeof collectNativeSourceEvidence>[0],
  config: string,
  context: TypeScriptSemanticDependencyContext,
): void {
  input.retainContext?.(config, context);
}
