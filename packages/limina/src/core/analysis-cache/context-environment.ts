import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import type { NativeContextRecord, ProjectRecord } from './contracts';
import { type EpochInputReplay, EpochInputs } from './epoch-inputs';
import { analysisHash, nativeContextId } from './identity';
import type { NativeAnalysisCache } from './native-cache';
import { observeTypeEnvironment } from './type-environment';

interface ContextEnvironment {
  record: NativeContextRecord;
  state: ProjectRecord;
}

export function currentContextReads(
  cache: NativeAnalysisCache,
  project: TypeScriptSemanticProject,
  candidate: ContextEnvironment,
  replay?: EpochInputReplay,
): EpochInputs | undefined {
  if (!hasCurrentTypeEnvironment(cache, project, candidate)) return undefined;
  const reads = new EpochInputs(cache.inputs);
  const { record } = candidate;
  if (record.native === undefined) return reads;
  const owner = record.project.sourceConfigPath ?? record.project.configPath;
  const closure = cache.configClosures.get(owner);
  const currentConfigs =
    closure !== undefined && cache.inputs.configCurrent(closure)
      ? new Set(closure)
      : undefined;
  return reads.validateSynchronous(
    record.native.discovery,
    replay,
    currentConfigs,
  )
    ? reads
    : undefined;
}

export function hasCurrentTypeEnvironment(
  cache: NativeAnalysisCache,
  project: TypeScriptSemanticProject,
  candidate: ContextEnvironment,
): boolean {
  const current = observeTypeEnvironment(project, cache.inputs);
  const isCurrent =
    analysisHash(current) === analysisHash(candidate.record.environment);
  if (!isCurrent)
    cache.invalidation.invalidateContext(nativeContextId(project));
  return isCurrent && current.evidence === 'observed';
}
