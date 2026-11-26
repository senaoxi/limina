import { formatReferenceBoundaryProblem } from './reference-boundary';
import type { ReferenceImportOptions } from './reference-import-types';
import { isLocalPathOutsideActivatedRegions } from './source-projects';

/**
Check resolved requests even when the compiler did not demand a project reference.
*/
export function recordRequestGovernanceProblems(
  options: ReferenceImportOptions,
): void {
  const resolvedFilePath = options.projectDependency.resolvedFilePath;
  const { config, activatedRegions } = options.context;
  if (
    activatedRegions.findBoundaryForPath(resolvedFilePath) !== null ||
    (isNativeSourceObservation(options) &&
      isLocalPathOutsideActivatedRegions({
        config,
        activatedRegions,
        filePath: resolvedFilePath,
      }))
  )
    options.context.problems.push(
      formatReferenceBoundaryProblem({
        config,
        activatedRegions,
        resolvedFilePath,
        project: options.project,
        importRecord: options.importRecord,
      }),
    );
}

function isNativeSourceObservation(options: ReferenceImportOptions): boolean {
  return (
    options.projectDependency.targetKind === 'source' &&
    options.projectDependency.nativeFact?.nativeEvidence !== undefined
  );
}
