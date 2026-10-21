import { formatReferenceBoundaryProblem } from './reference-boundary';
import type { ReferenceImportOptions } from './reference-import-types';
import { isLocalPathOutsideActivatedRegions } from './source-projects';

/**
Apply the existing activated-region rule to observations independently of
compilation obligations. Being uncovered alone is not this rule's predicate.
*/
export function recordNativeGovernanceProblems(
  options: ReferenceImportOptions,
): void {
  if (!isNativeSourceObservation(options)) return;
  const resolvedFilePath = options.projectDependency.resolvedFilePath;
  const { config, activatedRegions } = options.context;
  if (
    isLocalPathOutsideActivatedRegions({
      config,
      activatedRegions,
      filePath: resolvedFilePath,
    })
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
