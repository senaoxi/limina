import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import type { NativeContextRecord, ProjectRecord } from './contracts';
import type { EpochInputReplay } from './epoch-inputs';
import { analysisHash, nativeContextId } from './identity';
import { observeTypeEnvironment } from './installation-environment';
import type { NativeAnalysisCache } from './native-cache';

interface ContextEnvironment {
  record: NativeContextRecord;
  state: ProjectRecord;
}

export function hasCurrentContextEnvironment(
  cache: NativeAnalysisCache,
  project: TypeScriptSemanticProject,
  candidate: ContextEnvironment,
  replay?: EpochInputReplay,
): boolean {
  return (
    hasCurrentCompilerReads(cache, candidate.record, replay) &&
    hasCurrentInstallationEnvironment(cache, project, candidate)
  );
}

function hasCurrentCompilerReads(
  cache: NativeAnalysisCache,
  record: NativeContextRecord,
  replay?: EpochInputReplay,
): boolean {
  return (
    record.native === undefined ||
    cache.epoch.validateSynchronous(record.native.discovery, replay)
  );
}

function hasCurrentInstallationEnvironment(
  cache: NativeAnalysisCache,
  project: TypeScriptSemanticProject,
  candidate: ContextEnvironment,
): boolean {
  const current = observeTypeEnvironment(project, cache.inputs, {
    members: candidate.state.members,
  });
  if (
    analysisHash(current.domains) !==
    analysisHash(candidate.record.environment.domains)
  )
    cache.invalidation.invalidateContext(nativeContextId(project));
  return (
    current.evidence !== 'unknown' &&
    analysisHash(current) === analysisHash(candidate.record.environment)
  );
}
