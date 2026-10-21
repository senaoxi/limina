import type { ProjectDependency } from '../project-dependencies/contracts';
import { qualifiedNativeDependencyTarget } from '../typescript-semantic/native-fact-qualification';

export function nativeFrameworkTarget(
  options: {
    source: { configPath: string };
    projectDependency: ProjectDependency;
  },
  evidence: NonNullable<
    NonNullable<ProjectDependency['nativeFact']>['nativeEvidence']
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
