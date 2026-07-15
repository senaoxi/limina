import path from 'pathe';

import {
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import { createExternalArtifactStableId } from '../../../domain/artifacts/namespace';

export const generatedRootDirName: string = '.limina';
export const generatedTsconfigDir: string = path.join(
  generatedRootDirName,
  'tsconfig',
);
export const generatedManifestPath: string = path.join(
  generatedRootDirName,
  'manifest.json',
);

const generatedDtsDir = path.join(generatedRootDirName, 'dts');
const generatedTsbuildinfoDir = path.join(generatedRootDirName, 'tsbuildinfo');

export function createRelativePath(fromFile: string, toPath: string): string {
  const relativePath = toPosixPath(
    path.relative(path.dirname(fromFile), toPath),
  );

  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function createDtsFileName(sourceFileName: string): string {
  return sourceFileName === 'tsconfig.json'
    ? 'tsconfig.dts.json'
    : sourceFileName.replace(/\.json$/u, '.dts.json');
}

export function createSourceConfigScope(sourceConfigPath: string): string {
  const fileName = path.basename(sourceConfigPath);

  if (fileName === 'tsconfig.json') {
    return 'tsconfig';
  }

  return fileName.replace(/^tsconfig\./u, '').replace(/\.json$/u, '');
}

function createOutputFileName(sourceFileName: string): string {
  return sourceFileName === 'tsconfig.json'
    ? 'tsconfig.output.json'
    : sourceFileName.replace(/\.json$/u, '.output.json');
}

function getManagedSourceRelativeDirectory(options: {
  packageRootDir?: string;
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeSourcePath = toRelativePath(
    options.rootDir,
    options.sourceConfigPath,
  );
  const relativeDir = path.dirname(relativeSourcePath);
  if (
    relativeSourcePath !== '..' &&
    !relativeSourcePath.startsWith(`..${path.sep}`)
  ) {
    return relativeDir === '.' ? '' : relativeDir;
  }
  if (!options.packageRootDir) {
    throw new Error(
      `External source config requires an activated package root: ${options.sourceConfigPath}.`,
    );
  }
  const packageDisplayRoot = toPosixPath(
    toRelativePath(options.rootDir, options.packageRootDir),
  );
  const packageRelativeSourcePath = toRelativePath(
    options.packageRootDir,
    options.sourceConfigPath,
  );
  if (
    packageRelativeSourcePath === '..' ||
    packageRelativeSourcePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      'External source config is outside its activated package root.',
    );
  }
  const packageRelativeDirectory = path.dirname(packageRelativeSourcePath);
  return path.join(
    'external',
    createExternalArtifactStableId(packageDisplayRoot),
    ...(packageRelativeDirectory === '.'
      ? []
      : packageRelativeDirectory.split(path.sep)),
  );
}

export function getGeneratedDtsConfigPath(options: {
  checkerName: string;
  packageRootDir?: string;
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeSourcePath = toRelativePath(
    options.rootDir,
    options.sourceConfigPath,
  );
  const relativeDir = getManagedSourceRelativeDirectory(options);
  const dtsFileName = createDtsFileName(path.basename(relativeSourcePath));

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedTsconfigDir,
      'checkers',
      options.checkerName,
      'projects',
      relativeDir === '.' ? '' : relativeDir,
      dtsFileName,
    ),
  );
}

export function getGeneratedSolutionBuildConfigPath(options: {
  checkerName: string;
  packageRootDir?: string;
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeDir = getManagedSourceRelativeDirectory(options);

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedTsconfigDir,
      'checkers',
      options.checkerName,
      'solutions',
      relativeDir === '.' ? '' : relativeDir,
      'tsconfig.build.json',
    ),
  );
}

export function getGeneratedOutputProjectConfigPath(options: {
  checkerName: string;
  packageRootDir?: string;
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeSourcePath = toRelativePath(
    options.rootDir,
    options.sourceConfigPath,
  );
  const relativeDir = getManagedSourceRelativeDirectory(options);
  const outputFileName = createOutputFileName(
    path.basename(relativeSourcePath),
  );

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedTsconfigDir,
      'checkers',
      options.checkerName,
      'outputs',
      'projects',
      relativeDir === '.' ? '' : relativeDir,
      outputFileName,
    ),
  );
}

export function getGeneratedOutputSolutionConfigPath(options: {
  checkerName: string;
  packageRootDir?: string;
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeDir = getManagedSourceRelativeDirectory(options);

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedTsconfigDir,
      'checkers',
      options.checkerName,
      'outputs',
      'solutions',
      relativeDir === '.' ? '' : relativeDir,
      'tsconfig.output.json',
    ),
  );
}

export function getGeneratedCheckerEntryPath(options: {
  checkerName: string;
  rootDir: string;
}): string {
  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedTsconfigDir,
      'checkers',
      options.checkerName,
      'tsconfig.build.json',
    ),
  );
}

export function getGeneratedOutDir(options: {
  checkerName: string;
  packageRootDir?: string;
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeDir = getManagedSourceRelativeDirectory(options);

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedDtsDir,
      'checkers',
      options.checkerName,
      relativeDir === '.' ? '' : relativeDir,
      createSourceConfigScope(options.sourceConfigPath),
    ),
  );
}

export function getGeneratedTsBuildInfoPath(options: {
  checkerName: string;
  packageRootDir?: string;
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeDir = getManagedSourceRelativeDirectory(options);

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedTsbuildinfoDir,
      'checkers',
      options.checkerName,
      relativeDir === '.' ? '' : relativeDir,
      `${createSourceConfigScope(options.sourceConfigPath)}.tsbuildinfo`,
    ),
  );
}

export function getGeneratedOutputTsBuildInfoPath(options: {
  packageRootDir?: string;
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeDir = getManagedSourceRelativeDirectory(options);

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedTsbuildinfoDir,
      'build',
      relativeDir === '.' ? '' : relativeDir,
      `${createSourceConfigScope(options.sourceConfigPath)}.tsbuildinfo`,
    ),
  );
}
