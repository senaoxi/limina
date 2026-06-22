import path from 'pathe';

import {
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';

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

function createSourceConfigScope(sourceConfigPath: string): string {
  const fileName = path.basename(sourceConfigPath);

  if (fileName === 'tsconfig.json') {
    return 'tsconfig';
  }

  return fileName.replace(/^tsconfig\./u, '').replace(/\.json$/u, '');
}

export function getGeneratedDtsConfigPath(options: {
  checkerName: string;
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeSourcePath = toRelativePath(
    options.rootDir,
    options.sourceConfigPath,
  );
  const relativeDir = path.dirname(relativeSourcePath);
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
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeSourcePath = toRelativePath(
    options.rootDir,
    options.sourceConfigPath,
  );
  const relativeDir = path.dirname(relativeSourcePath);

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
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeSourcePath = toRelativePath(
    options.rootDir,
    options.sourceConfigPath,
  );
  const relativeDir = path.dirname(relativeSourcePath);

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
  rootDir: string;
  sourceConfigPath: string;
}): string {
  const relativeSourcePath = toRelativePath(
    options.rootDir,
    options.sourceConfigPath,
  );
  const relativeDir = path.dirname(relativeSourcePath);

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
