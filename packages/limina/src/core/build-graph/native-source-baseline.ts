import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import type { TypeScriptSemanticDependencyContext } from '../typescript-semantic/contracts';
import { coreCollectionRun, recordCoreWork } from './core-collection-run';
import { collectNativeSourceEvidence } from './native-source-collection';

/**
Collection completes before any ownership or governance decision can throw.
*/
export function prepareNativeSourceBaseline(
  input: Parameters<typeof collectNativeSourceEvidence>[0] & {
    projectDependencyCaches?: ProjectDependencyCaches;
  },
): NativeEvidenceSnapshot {
  const contexts = new Map<string, TypeScriptSemanticDependencyContext>();
  const services: Partial<ProjectDependencyCaches> =
    input.projectDependencyCaches ?? {};
  const snapshot = collectNativeSourceEvidence({
    ...input,
    analysisCache: services.analysisCache,
    metrics: services.metrics,
    retainContext: (config, context) => contexts.set(config, context),
  });
  if (input.projectDependencyCaches !== undefined)
    retainBaseline(input.projectDependencyCaches, contexts, snapshot);
  return snapshot;
}
function retainBaseline(
  caches: ProjectDependencyCaches,
  contexts: Map<string, TypeScriptSemanticDependencyContext>,
  snapshot: NativeEvidenceSnapshot,
): void {
  const run = coreCollectionRun(caches);
  for (const failure of snapshot.failures) run.failureIds.add(failure.id);
  retainFailedBaseline(caches, snapshot);
  for (const context of snapshot.contexts)
    retainBaselineWork(caches, snapshot, context.inputs.config);
  caches.nativeSourceEvidence = snapshot;
  caches.nativeSourceContexts = contexts;
  caches.sourceConfigCoverage = snapshot.coverageIndexes[0];
}
function retainFailedBaseline(
  caches: ProjectDependencyCaches,
  snapshot: NativeEvidenceSnapshot,
): void {
  const configs = baselineConfigs(snapshot);
  const failed = configs.filter((config) => config.state === 'failed');
  for (const config of failed)
    recordCoreWork(caches, {
      configPath: config.configId,
      phase: 'baseline',
      family: 'typescript',
      eligibility: 'eligible',
      execution: 'failed',
      reason: config.failureId,
    });
}
function retainBaselineWork(
  caches: ProjectDependencyCaches,
  snapshot: NativeEvidenceSnapshot,
  configPath: string,
): void {
  const hasFailure = snapshot.failures.some((failure) =>
    failure.evidenceIds.includes(configPath),
  );
  recordCoreWork(caches, {
    configPath,
    phase: 'baseline',
    family: 'typescript',
    eligibility: 'eligible',
    execution: hasFailure ? 'failed' : 'completed',
  });
}

function baselineConfigs(snapshot: NativeEvidenceSnapshot) {
  return snapshot.coverageIndexes[0]?.configurations ?? [];
}
