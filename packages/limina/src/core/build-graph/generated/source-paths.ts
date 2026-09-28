import { toPosixPath, toRelativePath } from '#utils/path';
import path from 'pathe';
import { createExternalArtifactStableId } from '../../../domain/artifacts/namespace';

export interface ManagedSourceRelativeDirectoryOptions {
  packageRootDir?: string;
  rootDir: string;
  sourceConfigPath: string;
}

function isOutsideDirectory(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`);
}

function normalizeRelativeDirectory(relativePath: string): string {
  const relativeDirectory = path.dirname(relativePath);
  return relativeDirectory === '.' ? '' : relativeDirectory;
}

function getInternalRelativeDirectory(
  relativeSourcePath: string,
): string | null {
  if (isOutsideDirectory(relativeSourcePath)) {
    return null;
  }

  return normalizeRelativeDirectory(relativeSourcePath);
}

function requireActivatedPackageRoot(
  options: ManagedSourceRelativeDirectoryOptions,
): string {
  if (options.packageRootDir === undefined) {
    throw new Error(
      `External source config requires an activated package root: ${options.sourceConfigPath}.`,
    );
  }

  return options.packageRootDir;
}

function assertInsideActivatedPackage(packageRelativePath: string): void {
  if (isOutsideDirectory(packageRelativePath)) {
    throw new Error(
      'External source config is outside its activated package root.',
    );
  }
}

function getExternalRelativeDirectory(options: {
  packageRootDir: string;
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const packageDisplayRoot = toPosixPath(
    toRelativePath(options.rootDir, options.packageRootDir),
  );
  const packageRelativeSourcePath = toRelativePath(
    options.packageRootDir,
    options.sourceConfigPath,
  );
  assertInsideActivatedPackage(packageRelativeSourcePath);

  const relativeDirectory = normalizeRelativeDirectory(
    packageRelativeSourcePath,
  );
  const directorySegments =
    relativeDirectory.length === 0 ? [] : relativeDirectory.split(path.sep);

  return path.join(
    'external',
    createExternalArtifactStableId(packageDisplayRoot),
    ...directorySegments,
  );
}

export function getManagedSourceRelativeDirectory(
  options: ManagedSourceRelativeDirectoryOptions,
): string {
  const relativeSourcePath = toRelativePath(
    options.rootDir,
    options.sourceConfigPath,
  );
  const internalDirectory = getInternalRelativeDirectory(relativeSourcePath);

  if (internalDirectory !== null) {
    return internalDirectory;
  }

  return getExternalRelativeDirectory({
    packageRootDir: requireActivatedPackageRoot(options),
    rootDir: options.rootDir,
    sourceConfigPath: options.sourceConfigPath,
  });
}
