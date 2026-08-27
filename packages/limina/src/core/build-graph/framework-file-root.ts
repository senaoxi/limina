import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';

export function getFrameworkFilePackageRoot(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  fallbackPackageRootDir: string;
  fileName: string;
}): string {
  return (
    options.activatedRegions.findPackageForPath(options.fileName)?.directory ??
    options.fallbackPackageRootDir
  );
}
