import { isNativeTypeScriptProjectInput } from '#checkers';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import { getEffectiveImporterRoots } from '../typescript-semantic/effective-roots';
import type { NativeContextRecord, ProjectRecord } from './contracts';
import { analysisHash } from './identity';
export function isCurrentContextShape(
  project: TypeScriptSemanticProject,
  candidate: { record: NativeContextRecord; state: ProjectRecord },
): boolean {
  const roots = getEffectiveImporterRoots(project).filter(
    isNativeTypeScriptProjectInput,
  );
  return [
    analysisHash(roots) === analysisHash(candidate.state.roots),
    hasCurrentCoverage(project, candidate.record),
    candidate.record.boundary.every(
      ([file, allowed]) =>
        project.workspaceSourceBoundary.has(file) === allowed,
    ),
  ].every(Boolean);
}
function hasCurrentCoverage(
  project: TypeScriptSemanticProject,
  record: NativeContextRecord,
): boolean {
  return project.admissionMode === 'coverage-bounded'
    ? record.native?.boundaryIdentity ===
        project.workspaceSourceBoundary.identity
    : record.native === undefined;
}
