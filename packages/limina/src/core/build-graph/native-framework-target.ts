import type { ReferenceDependency } from '../project-dependencies/reference-facts';
import { qualifiedNativeDependencyTarget } from '../typescript-semantic/native-fact-qualification';

export function nativeFrameworkTarget(
  options: {
    source: { configPath: string };
    projectDependency: ReferenceDependency;
  },
  evidence: NonNullable<
    NonNullable<ReferenceDependency['nativeFact']>['nativeEvidence']
  >,
): {
  targetConfigPath: string;
  resolution: { filePath: string; owners: string[] };
} | null {
  const targetConfigPath = qualifiedNativeDependencyTarget(evidence);
  return [null, options.source.configPath].includes(targetConfigPath)
    ? null
    : {
        targetConfigPath: targetConfigPath!,
        resolution: {
          filePath: options.projectDependency.resolvedFilePath,
          owners: [targetConfigPath!],
        },
      };
}
