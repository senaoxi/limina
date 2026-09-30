import path from 'pathe';

import {
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import { getManagedSourceRelativeDirectory } from './source-paths';

const generatedRootDirectoryName: string = '.limina';
export const generatedTsconfigDirectory: string = path.join(
  generatedRootDirectoryName,
  'tsconfig',
);
export const generatedManifestPath: string = path.join(
  generatedRootDirectoryName,
  'manifest.json',
);

const generatedDtsDirectory = path.join(generatedRootDirectoryName, 'dts');
const generatedTsbuildinfoDirectory = path.join(
  generatedRootDirectoryName,
  'tsbuildinfo',
);

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
  return path.basename(sourceConfigPath);
}

function createOutputFileName(sourceFileName: string): string {
  return sourceFileName === 'tsconfig.json'
    ? 'tsconfig.output.json'
    : sourceFileName.replace(/\.json$/u, '.output.json');
}

function createBuildFileName(sourceFileName: string): string {
  return sourceFileName === 'tsconfig.json'
    ? 'tsconfig.build.json'
    : sourceFileName.replace(/\.json$/u, '.build.json');
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
  const relativeDirectory = getManagedSourceRelativeDirectory(options);
  const dtsFileName = createDtsFileName(path.basename(relativeSourcePath));

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedTsconfigDirectory,
      'checkers',
      options.checkerName,
      'projects',
      relativeDirectory === '.' ? '' : relativeDirectory,
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
  const relativeDirectory = getManagedSourceRelativeDirectory(options);

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedTsconfigDirectory,
      'checkers',
      options.checkerName,
      'solutions',
      relativeDirectory === '.' ? '' : relativeDirectory,
      'tsconfig.build.json',
    ),
  );
}

export function getGeneratedLeafSolutionBuildConfigPath(options: {
  checkerName: string;
  packageRootDir?: string;
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeDirectory = getManagedSourceRelativeDirectory(options);
  const buildFileName = createBuildFileName(
    path.basename(options.sourceConfigPath),
  );

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedTsconfigDirectory,
      'checkers',
      options.checkerName,
      'solutions',
      relativeDirectory === '.' ? '' : relativeDirectory,
      buildFileName,
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
  const relativeDirectory = getManagedSourceRelativeDirectory(options);
  const outputFileName = createOutputFileName(
    path.basename(relativeSourcePath),
  );

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedTsconfigDirectory,
      'checkers',
      options.checkerName,
      'outputs',
      'projects',
      relativeDirectory === '.' ? '' : relativeDirectory,
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
  const relativeDirectory = getManagedSourceRelativeDirectory(options);

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedTsconfigDirectory,
      'checkers',
      options.checkerName,
      'outputs',
      'solutions',
      relativeDirectory === '.' ? '' : relativeDirectory,
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
      generatedTsconfigDirectory,
      'checkers',
      options.checkerName,
      'tsconfig.build.json',
    ),
  );
}

function getGeneratedOutputDirectory(options: {
  checkerName: string;
  packageRootDir?: string;
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeDirectory = getManagedSourceRelativeDirectory(options);

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedDtsDirectory,
      'checkers',
      options.checkerName,
      relativeDirectory === '.' ? '' : relativeDirectory,
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
  const relativeDirectory = getManagedSourceRelativeDirectory(options);

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedTsbuildinfoDirectory,
      'checkers',
      options.checkerName,
      relativeDirectory === '.' ? '' : relativeDirectory,
      `${createSourceConfigScope(options.sourceConfigPath)}.tsbuildinfo`,
    ),
  );
}

export function getGeneratedOutputTsBuildInfoPath(options: {
  packageRootDir?: string;
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeDirectory = getManagedSourceRelativeDirectory(options);

  return normalizeAbsolutePath(
    path.join(
      options.rootDir,
      generatedTsbuildinfoDirectory,
      'build',
      relativeDirectory === '.' ? '' : relativeDirectory,
      `${createSourceConfigScope(options.sourceConfigPath)}.tsbuildinfo`,
    ),
  );
}

export {
  generatedRootDirectoryName as generatedRootDirName,
  getGeneratedOutputDirectory as getGeneratedOutDir,
};
