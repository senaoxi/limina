import { resolveLeafInstalledPackageDirectory } from '../core/packages/leaf-package-resolution';

export function resolveFrameworkPackageFromRoot(options: {
  packageName: string;
  projectRootDir: string;
}): string | undefined {
  return (
    resolveLeafInstalledPackageDirectory({
      packageName: options.packageName,
      packageRootDir: options.projectRootDir,
    }) ?? undefined
  );
}
