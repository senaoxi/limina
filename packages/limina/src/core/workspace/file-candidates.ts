import { observeAnalysisRead } from '#utils/analysis-input';
import {
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import rawPicomatch from 'picomatch';
import { escapePath, glob } from 'tinyglobby';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from './validated-context';

export interface WorkspaceRegionFilePathIndex {
  isInsideActivatedRegion(filePath: string): boolean;
}

const picomatch = rawPicomatch as unknown as (
  pattern: string,
  options?: { dot?: boolean; posixSlashes?: boolean },
) => (value: string) => boolean;

export function createCandidateGlobMatcher(
  patterns: readonly string[],
): (relativePath: string) => boolean {
  const positives = patterns
    .filter((pattern) => !pattern.startsWith('!'))
    .map((pattern) => picomatch(pattern, { dot: true, posixSlashes: true }));
  const negatives = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) =>
      picomatch(pattern.slice(1), { dot: true, posixSlashes: true }),
    );

  return (relativePath) =>
    positives.some((matches) => matches(relativePath)) &&
    negatives.every((matches) => !matches(relativePath));
}

function isNestedRelativeRoot(relativeRoot: string): boolean {
  return (
    !(relativeRoot === '.' || relativeRoot === '..') &&
    !relativeRoot.startsWith('../')
  );
}

function toStructuralIgnorePattern(
  packageDirectory: string,
  candidateRoot: string,
): string[] {
  const relativeRoot = toPosixPath(
    toRelativePath(packageDirectory, candidateRoot),
  );

  return isNestedRelativeRoot(relativeRoot)
    ? [`${escapePath(relativeRoot)}/**`]
    : [];
}

function collectStructuralIgnores(
  context: ValidatedWorkspaceContext,
  packageDirectory: string,
): string[] {
  const roots = [
    ...context.packages.map((workspacePackage) => workspacePackage.directory),
    ...context.boundaries.map((boundary) => boundary.rootDir),
  ];

  return roots.flatMap((candidateRoot) =>
    toStructuralIgnorePattern(packageDirectory, candidateRoot),
  );
}

async function collectPackageCandidates(
  context: ValidatedWorkspaceContext,
  packageDirectory: string,
): Promise<string[]> {
  const read = () =>
    glob('**/*', {
      absolute: true,
      cwd: packageDirectory,
      dot: true,
      followSymbolicLinks: false,
      ignore: [
        '**/.git/**',
        '**/.limina/**',
        '**/node_modules/**',
        ...new Set(collectStructuralIgnores(context, packageDirectory)),
      ],
      onlyFiles: true,
    });
  const value = await read();
  observeAnalysisRead({
    path: packageDirectory,
    descriptor: {
      kind: 'glob',
      patterns: ['**/*'],
      options: {
        absolute: true,
        cwd: packageDirectory,
        dot: true,
        followSymbolicLinks: false,
        onlyFiles: true,
        ignore: [
          '**/.git/**',
          '**/.limina/**',
          '**/node_modules/**',
          ...new Set(collectStructuralIgnores(context, packageDirectory)),
        ],
      },
    },
    key: `candidates:${packageDirectory}`,
    value,
    read,
  });
  return value;
}

export async function collectActivatedPackageFileCandidates(
  context: ValidatedWorkspaceContext,
  pathIndex: WorkspaceRegionFilePathIndex = new WorkspaceRegionPathIndex(
    context,
  ),
): Promise<string[]> {
  const candidates = (
    await Promise.all(
      context.packages.map((workspacePackage) =>
        collectPackageCandidates(context, workspacePackage.directory),
      ),
    )
  ).flat();

  return [...new Set(candidates.map(normalizeAbsolutePath))]
    .filter((filePath) => pathIndex.isInsideActivatedRegion(filePath))
    .sort((left, right) => left.localeCompare(right));
}
