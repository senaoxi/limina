import { qualifiedNativeDependencyTarget } from '../typescript-semantic/native-fact-qualification';
import type {
  ReferenceImportOptions,
  ReferenceTarget,
} from './reference-import-types';

/**
No legacy owner priority, directory heuristic or declaration producer guess.
*/
export function nativeReferenceTarget(
  options: ReferenceImportOptions,
): ReferenceTarget | null | undefined {
  const evidence = nativeEvidence(options);
  if (evidence === undefined) return undefined;
  const targetSourceConfigPath = qualifiedNativeDependencyTarget(evidence);
  return targetSourceConfigPath === null
    ? null
    : referenceTarget(options, targetSourceConfigPath);
}

function nativeEvidence(options: ReferenceImportOptions) {
  return options.projectDependency.nativeFact?.nativeEvidence;
}

function referenceTarget(
  options: ReferenceImportOptions,
  targetSourceConfigPath: string,
): ReferenceTarget {
  return {
    targetSourceConfigPath,
    resolvedFilePath: options.projectDependency.resolvedFilePath,
    providerSourceFilePaths: [options.projectDependency.resolvedFilePath],
  };
}
