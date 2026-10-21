import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import type { NativeContextRecord, ProjectRecord } from './contracts';
import { analysisHash } from './identity';
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
): boolean {
  return (
    hasCurrentCompilerReads(cache, candidate.record) &&
    hasCurrentInstallationEnvironment(cache, project, candidate)
  );
}

function hasCurrentCompilerReads(
  cache: NativeAnalysisCache,
  record: NativeContextRecord,
): boolean {
  return (
    record.native === undefined ||
    cache.epoch.validateSynchronous(record.native.discovery)
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
    cache.inputs.invalidateDomain(project.configPath);
  return (
    current.evidence !== 'unknown' &&
    analysisHash(current) === analysisHash(candidate.record.environment)
  );
}
